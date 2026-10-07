import type { ServerLogEntry } from '@image-playground/shared'
import { sql } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { serverLogBuffer } from './logger'

export async function writeServerLogs(entries: ServerLogEntry[]): Promise<void> {
  await db.insert(schema.server_logs).values(entries).onConflictDoNothing()
}

/** Seven days, capped at 200,000 rows; bounded deletes avoid long cleanup locks. */
export async function purgeServerLogs(now = Date.now()): Promise<void> {
  await db.execute(sql`
    DELETE FROM server_logs WHERE id IN (
      SELECT id FROM server_logs WHERE at < ${new Date(now - 7 * 86400_000)}
      ORDER BY at ASC LIMIT 5000
    )
  `)
  await db.execute(sql`
    DELETE FROM server_logs WHERE id IN (
      SELECT id FROM server_logs ORDER BY at DESC, id DESC OFFSET 200000 LIMIT 5000
    )
  `)
}

export function startServerLogs() {
  const timer = setInterval(() => void serverLogBuffer.flush(), 2000)
  timer.unref()
  let cleaning = false
  const cleanup = async () => {
    if (cleaning) return
    cleaning = true
    try {
      await purgeServerLogs()
    } catch {
      /* Keep stdout and business processing available. */
    } finally {
      cleaning = false
    }
  }
  void cleanup()
  const retention = setInterval(() => void cleanup(), 60_000)
  retention.unref()
  return async () => {
    clearInterval(timer)
    clearInterval(retention)
    await serverLogBuffer.drain()
  }
}

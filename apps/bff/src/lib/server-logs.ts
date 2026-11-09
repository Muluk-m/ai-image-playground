import type { ServerLogEntry } from '@image-playground/shared'
import { SQL } from 'bun'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sql'
import { config } from '../config'
import { schema } from '../db/client'
import { type MaintenanceTransaction, startSharedMaintenance } from './shared-maintenance'

function createLogDatabase() {
  const client = new SQL(process.env.DATABASE_URL?.trim() || config.databaseUrl, {
    max: 1,
    connectionTimeout: 2,
    idleTimeout: 60,
    connection: {
      application_name: 'aip-server-logs',
      statement_timeout: '1500',
      lock_timeout: '500',
    },
  })
  return { client, db: drizzle(client, { schema }) }
}
let logDatabase: ReturnType<typeof createLogDatabase> | undefined
function getLogDatabase() {
  return (logDatabase ??= createLogDatabase())
}
export async function closeServerLogDatabase() {
  const handle = logDatabase
  logDatabase = undefined
  if (handle) await handle.client.close({ timeout: 0 })
}

export async function writeServerLogs(entries: ServerLogEntry[]): Promise<void> {
  await getLogDatabase().db.insert(schema.server_logs).values(entries).onConflictDoNothing()
}

/** Seven days, capped at 200,000 rows; bounded deletes avoid long cleanup locks. */
export async function purgeServerLogs(
  now = Date.now(),
  database?: MaintenanceTransaction,
): Promise<void> {
  const db = database ?? getLogDatabase().db
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

/** One shared leader performs bounded retention; failures never block business processing. */
export function startServerLogs() {
  const stopMaintenance = startSharedMaintenance({
    job: 'server-logs',
    work: (transaction) => purgeServerLogs(Date.now(), transaction),
  })
  return async () => {
    await stopMaintenance()
    await closeServerLogDatabase()
  }
}

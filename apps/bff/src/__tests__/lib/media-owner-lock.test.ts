import { afterAll, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq, sql } from 'drizzle-orm'
import { waitFor } from '../helpers/upstreamStubs'

process.env.DATABASE_URL = await resetTestDatabase('bff_media_owner_lock')
const { db, schema, close } = await import('../../db/client')
const { lockMediaOwner } = await import('../../lib/projectMedia')
afterAll(close)

it('媒体属主锁继续互斥认领与回收，并阻塞账号删除', async () => {
  const userId = 'media-owner-lock'
  const now = Date.now()
  await db.insert(schema.users).values({
    id: userId,
    username: userId,
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let held = false
  const owner = db.transaction(async (tx) => {
    await lockMediaOwner(tx, userId)
    held = true
    await gate
  })
  await waitFor(() => held)
  let reclaimed = false
  const reclaim = db.transaction(async (tx) => {
    await lockMediaOwner(tx, userId)
    reclaimed = true
  })
  let deleted = false
  const deletion = db
    .delete(schema.users)
    .where(eq(schema.users.id, userId))
    .returning()
    .then((rows) => {
      deleted = rows.length === 1
    })
  try {
    await waitFor(async () => {
      const waiting = await db.execute(sql`
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND (query LIKE ${'%from "users"%for no key update%'} OR query LIKE ${'%delete from "users"%'})
      `)
      return waiting.length === 2
    })
    expect(reclaimed).toBe(false)
    expect(deleted).toBe(false)
  } finally {
    release()
    await Promise.all([owner, reclaim, deletion])
  }
  expect(reclaimed).toBe(true)
  expect(deleted).toBe(true)
})

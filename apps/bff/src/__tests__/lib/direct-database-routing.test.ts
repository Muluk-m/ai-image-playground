import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { sql } from 'drizzle-orm'

const TEST_DB = await resetTestDatabase('bff_direct_routing')

process.env.DATABASE_URL = TEST_DB
delete process.env.DIRECT_DATABASE_URL

const { close, db, directSql, resolveDirectDatabaseUrl } = await import('../../db/client')
const { CanvasSyncRooms } = await import('../../lib/canvasSyncRooms')
const { withMediaObjectLock } = await import('../../lib/mediaObjectLock')
const { createSharedMaintenance } = await import('../../lib/shared-maintenance')

afterEach(async () => {
  delete process.env.DIRECT_DATABASE_URL
  process.env.DATABASE_URL = TEST_DB
  await close()
})

afterAll(close)

describe('DIRECT_DATABASE_URL routing for session-level locks', () => {
  it('shares the primary pool when DIRECT_DATABASE_URL is unset (zero extra pools)', async () => {
    expect(resolveDirectDatabaseUrl()).toBe(TEST_DB)
    expect(directSql()).toBe(db.$client)
    const [row] = await directSql()`SELECT current_setting('application_name') AS app_name`
    expect(row?.app_name).toBe('aip-bff')
  })

  it('routes directSql, withMediaObjectLock and shared-maintenance exclusively via DIRECT_DATABASE_URL', async () => {
    // Point pooled DATABASE_URL at an unreachable endpoint so any accidental fallback fails immediately.
    process.env.DATABASE_URL = 'postgresql://invalid:invalid@127.0.0.1:1/unreachable'
    process.env.DIRECT_DATABASE_URL = TEST_DB
    expect(resolveDirectDatabaseUrl()).toBe(TEST_DB)

    const lockResult = await withMediaObjectLock('direct-route-media-1', async (database) => {
      const [row] = await database.execute<{ app_name: string; held: boolean }>(sql`
        SELECT current_setting('application_name') AS app_name,
               EXISTS (
                 SELECT 1 FROM pg_locks
                 WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND granted
               ) AS held
      `)
      return row
    })
    expect(lockResult).toEqual({ app_name: 'aip-bff-direct', held: true })

    let maintenanceAppName: string | undefined
    const maintenance = createSharedMaintenance({
      job: 'direct-route-probe',
      work: async (transaction) => {
        const [row] = await transaction.execute<{ app_name: string }>(
          sql`SELECT current_setting('application_name') AS app_name`,
        )
        maintenanceAppName = row?.app_name
      },
    })
    try {
      await maintenance.run()
    } finally {
      await maintenance.stop()
    }
    expect(maintenanceAppName).toBe('aip-maintenance:direct-route-probe')

    // CanvasSyncRooms LISTEN/NOTIFY must also bypass pooled DATABASE_URL via DIRECT_DATABASE_URL.
    const rooms = new CanvasSyncRooms()
    try {
      await rooms
        .join('direct-route-canvas', 'user-1', {
          authorize: async () => true,
          send: () => {},
          close: () => {},
        })
        .catch(() => {
          // refresh() reads via pooled db (intentionally unreachable here); listener setup runs first.
        })
      const [listener] = await directSql()`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = 'bff-canvas-listener'
      `
      expect(listener?.n).toBe(1)
    } finally {
      await rooms.close()
    }
  })
})

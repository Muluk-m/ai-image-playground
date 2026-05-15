import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { unlinkSync } from 'node:fs'

const TEST_DB = './artifacts/test-migrate.sqlite'

// 跟 routes.test.ts / upstream.test.ts 共享 process，必须在 import migrate
// (会触发 config 模块顶层求值) 之前注入 env，否则会污染其它测试的 databaseUrl。
process.env.SUB2API_BASE_URL = 'http://localhost:9999'
process.env.SUB2API_API_KEY = 'test-key'
process.env.DATABASE_URL = './artifacts/test-routes.sqlite'
process.env.PORT = '0'

const { runMigrations } = await import('../../db/migrate')

describe('runMigrations', () => {
  it('creates daily_quota table with correct columns + primary key', () => {
    try {
      unlinkSync(TEST_DB)
      unlinkSync(`${TEST_DB}-wal`)
      unlinkSync(`${TEST_DB}-shm`)
    } catch {}

    runMigrations(TEST_DB)

    const sqlite = new Database(TEST_DB)
    const cols = sqlite.query('PRAGMA table_info(daily_quota)').all() as Array<{
      name: string
      notnull: number
      pk: number
    }>
    expect(cols.length).toBeGreaterThan(0)

    const byName = Object.fromEntries(cols.map((c) => [c.name, c]))
    expect(byName.device_id).toMatchObject({ notnull: 1, pk: 1 })
    expect(byName.date).toMatchObject({ notnull: 1, pk: 2 })
    expect(byName.count).toMatchObject({ notnull: 1, pk: 0 })

    sqlite.close()
  })
})

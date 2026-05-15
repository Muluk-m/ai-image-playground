import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { mkdirSync, unlinkSync } from 'node:fs'
import { runMigrations } from '../migrate'

const TEST_DB = './artifacts/test-migrate.sqlite'

describe('runMigrations', () => {
  it('creates daily_quota table with correct columns + primary key', () => {
    // packages/db 自带测试，cwd 是 packages/db，artifacts/ 默认不存在，显式建一下。
    mkdirSync('./artifacts', { recursive: true })
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

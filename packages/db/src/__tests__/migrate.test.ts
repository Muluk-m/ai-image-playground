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

  it('tasks 表有 device_id 生成列 + idx_tasks_device_id 索引', () => {
    try {
      unlinkSync(TEST_DB)
      unlinkSync(`${TEST_DB}-wal`)
      unlinkSync(`${TEST_DB}-shm`)
    } catch {}

    const { runMigrations } = require('../migrate') as typeof import('../migrate')
    runMigrations(TEST_DB)

    const sqlite = new Database(TEST_DB)

    // device_id 列存在（VIRTUAL 生成列 hidden=2，PRAGMA table_info 看不到，必须用 table_xinfo）
    const taskCols = sqlite.query('PRAGMA table_xinfo(tasks)').all() as Array<{
      name: string
    }>
    expect(taskCols.some((c) => c.name === 'device_id')).toBe(true)

    // 索引存在
    const indexes = sqlite
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks'")
      .all() as Array<{ name: string }>
    expect(indexes.some((i) => i.name === 'idx_tasks_device_id')).toBe(true)

    // 验证生成列实际工作：插入一条带 device_id 的 task，json_extract 应抽出
    sqlite.exec(`
      INSERT INTO tasks (id, provider, model, status, request_payload, submitted_at)
      VALUES ('t1', 'openai-compat', 'm', 'queued',
              '{"prompt":"x","device_id":"dev-aaaaaaaa"}', ${Date.now()})
    `)
    const row = sqlite.query("SELECT device_id FROM tasks WHERE id='t1'").get() as {
      device_id: string | null
    }
    expect(row.device_id).toBe('dev-aaaaaaaa')

    sqlite.close()
  })

  it('runMigrations 可重复执行（idempotent）—— 兼容 BFF 重启', () => {
    try {
      unlinkSync(TEST_DB)
      unlinkSync(`${TEST_DB}-wal`)
      unlinkSync(`${TEST_DB}-shm`)
    } catch {}

    // 跑三次都不能抛 —— 关键是 PRAGMA table_xinfo 必须能看到 VIRTUAL 生成列，
    // 否则第二次 ALTER 会报 duplicate column name。
    expect(() => {
      runMigrations(TEST_DB)
      runMigrations(TEST_DB)
      runMigrations(TEST_DB)
    }).not.toThrow()
  })
})

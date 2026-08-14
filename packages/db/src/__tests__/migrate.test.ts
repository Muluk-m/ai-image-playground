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

  it('tasks 表有 device_id 生成列 + admin 复合索引', () => {
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

    // admin 设备列表/详情聚合必须走复合索引，让 submitted_at/status/model 直接
    // 来自索引。旧的单列索引会为这些字段逐条读取多 MB 胖行，应被替换。
    const indexes = sqlite
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks'")
      .all() as Array<{ name: string }>
    expect(indexes.some((i) => i.name === 'idx_tasks_admin_device_time')).toBe(true)
    expect(indexes.some((i) => i.name === 'idx_tasks_device_id')).toBe(false)

    const adminIndexColumns = sqlite
      .query('PRAGMA index_info(idx_tasks_admin_device_time)')
      .all() as Array<{ name: string }>
    expect(adminIndexColumns.map((c) => c.name)).toEqual([
      'device_id',
      'submitted_at',
      'id',
      'status',
      'model',
    ])

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

    const aggregatePlan = sqlite
      .query(`
        EXPLAIN QUERY PLAN
        SELECT
          device_id,
          MIN(submitted_at),
          MAX(submitted_at),
          COUNT(*),
          SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),
          SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),
          GROUP_CONCAT(DISTINCT model)
        FROM tasks
        WHERE submitted_at >= 0 AND device_id IS NOT NULL
        GROUP BY device_id
        ORDER BY MAX(submitted_at) DESC
        LIMIT 501
      `)
      .all() as Array<{ detail: string }>
    const aggregatePlanText = aggregatePlan.map((row) => row.detail).join('\n')
    expect(aggregatePlanText).toContain('USING INDEX idx_tasks_admin_device_time')

    const taskListPlan = sqlite
      .query(`
        EXPLAIN QUERY PLAN
        SELECT
          id, provider, model, status, submitted_at, started_at,
          completed_at, error_type, request_payload, attempt_count
        FROM tasks
        WHERE device_id = 'dev-aaaaaaaa' AND submitted_at >= 0
        ORDER BY submitted_at DESC, id DESC
        LIMIT 101
      `)
      .all() as Array<{ detail: string }>
    const taskListPlanText = taskListPlan.map((row) => row.detail).join('\n')
    expect(taskListPlanText).toContain('USING INDEX idx_tasks_admin_device_time')
    expect(taskListPlanText).not.toContain('USE TEMP B-TREE FOR ORDER BY')

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

  it('老库从 idx_tasks_device_id 原地迁移到 admin 复合索引', () => {
    try {
      unlinkSync(TEST_DB)
      unlinkSync(`${TEST_DB}-wal`)
      unlinkSync(`${TEST_DB}-shm`)
    } catch {}

    const legacy = new Database(TEST_DB)
    legacy.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        request_payload TEXT NOT NULL,
        result_payload TEXT,
        error_message TEXT,
        error_type TEXT,
        submitted_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        client_request_id TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        device_id TEXT GENERATED ALWAYS AS (
          json_extract(request_payload, '$.device_id')
        ) VIRTUAL
      );
      CREATE INDEX idx_tasks_device_id ON tasks(device_id);
      INSERT INTO tasks (
        id, provider, model, status, request_payload, result_payload, submitted_at
      ) VALUES (
        'legacy-1', 'openai-compat', 'm', 'completed',
        '{"prompt":"x","device_id":"legacy-device"}',
        '{"data":[{"b64_json":"AAAA"}]}',
        ${Date.now()}
      );
    `)
    legacy.close()

    runMigrations(TEST_DB)

    const migrated = new Database(TEST_DB)
    const indexes = migrated
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks'")
      .all() as Array<{ name: string }>
    expect(indexes.some((i) => i.name === 'idx_tasks_admin_device_time')).toBe(true)
    expect(indexes.some((i) => i.name === 'idx_tasks_device_id')).toBe(false)
    const row = migrated.query("SELECT device_id FROM tasks WHERE id='legacy-1'").get() as {
      device_id: string
    }
    expect(row.device_id).toBe('legacy-device')
    migrated.close()
  })

  it('老库补齐 upstream_status / upstream_body 列', () => {
    try {
      unlinkSync(TEST_DB)
      unlinkSync(`${TEST_DB}-wal`)
      unlinkSync(`${TEST_DB}-shm`)
    } catch {}

    // 生产库就是这个形状：建于 upstream_* 两列之前，CREATE TABLE IF NOT EXISTS
    // 不会补列，必须靠 ALTER 分支。
    const legacy = new Database(TEST_DB)
    legacy.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        request_payload TEXT NOT NULL,
        result_payload TEXT,
        error_message TEXT,
        error_type TEXT,
        submitted_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        client_request_id TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER
      );
      INSERT INTO tasks (id, provider, model, status, request_payload, submitted_at)
      VALUES ('legacy-2', 'openai-compat', 'm', 'failed', '{"prompt":"x"}', ${Date.now()});
    `)
    legacy.close()

    runMigrations(TEST_DB)

    const migrated = new Database(TEST_DB)
    const cols = migrated.query('PRAGMA table_info(tasks)').all() as Array<{
      name: string
      type: string
    }>
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]))
    expect(byName.upstream_status).toMatchObject({ type: 'INTEGER' })
    expect(byName.upstream_body).toMatchObject({ type: 'TEXT' })
    // 老行补列后为 NULL，不影响既有数据
    const row = migrated
      .query("SELECT upstream_status, upstream_body FROM tasks WHERE id='legacy-2'")
      .get() as { upstream_status: number | null; upstream_body: string | null }
    expect(row).toEqual({ upstream_status: null, upstream_body: null })
    migrated.close()
  })
})

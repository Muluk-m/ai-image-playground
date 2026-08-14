import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import { unlinkSync } from 'node:fs'
import { drizzle } from 'drizzle-orm/bun-sqlite'

const TEST_DB = './artifacts/test-quota.sqlite'

try {
  unlinkSync(TEST_DB)
  unlinkSync(`${TEST_DB}-wal`)
  unlinkSync(`${TEST_DB}-shm`)
} catch {
  /* not exists */
}

// 必须早于任何 config / db client import，避免污染共享 process 的 env
// （routes.test.ts 顶层有 unlinkSync(test-routes.sqlite) + runMigrations，
// 因此本测试不能让 db/client 模块跟 routes.test.ts 抢同一个 DB 文件 inode）。
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = './artifacts/test-routes.sqlite'
process.env.PORT = '0'
process.env.CORS_ALLOWED_ORIGINS = '*'

const { runMigrations } = await import('../../db/migrate')
runMigrations(TEST_DB)

// 用独立 sqlite 文件 + 独立 drizzle 实例，注入到 tryConsumeQuota 的 dbInstance
// 参数，完全绕开 db/client 全局单例，避免 routes.test.ts 顶层 unlink 让单例
// 指向悬空 inode。
const sqlite = new Database(TEST_DB)
sqlite.exec('PRAGMA journal_mode = WAL;')
const schema = await import('../../db/schema')
const db = drizzle(sqlite, { schema })

const { tryConsumeQuota, currentQuotaDate, nextResetISO } = await import('../../lib/quota')

async function resetQuota() {
  await db.delete(schema.daily_quota)
}

describe('tryConsumeQuota', () => {
  beforeEach(async () => {
    await resetQuota()
  })

  it('首次消费写入计数', async () => {
    const r = await tryConsumeQuota('dev-1', 5, db)
    expect(r.ok).toBe(true)
    expect(r.count).toBe(5)
    expect(r.reset_at).toBe(nextResetISO())
  })

  it('累计 8 次 n=10 到达 80', async () => {
    for (let i = 1; i <= 8; i++) {
      const r = await tryConsumeQuota('dev-1', 10, db)
      expect(r.ok).toBe(true)
      expect(r.count).toBe(i * 10)
    }
  })

  it('累计到 80 后第 81 次（n=1）返回 ok=false 且 count 保持 80', async () => {
    for (let i = 0; i < 8; i++) await tryConsumeQuota('dev-1', 10, db)
    const r = await tryConsumeQuota('dev-1', 1, db)
    expect(r.ok).toBe(false)
    expect(r.count).toBe(80)
  })

  it('单次 n 超出剩余额度（已 78，n=3）返回 ok=false 且 count 保持 78', async () => {
    await tryConsumeQuota('dev-1', 78, db)
    const r = await tryConsumeQuota('dev-1', 3, db)
    expect(r.ok).toBe(false)
    expect(r.count).toBe(78)
  })

  it('不同 device_id 各自独立计数', async () => {
    await tryConsumeQuota('dev-1', 80, db)
    const r = await tryConsumeQuota('dev-2', 80, db)
    expect(r.ok).toBe(true)
    expect(r.count).toBe(80)
  })

  it('currentQuotaDate 返 YYYY-MM-DD UTC', () => {
    const date = currentQuotaDate()
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(date).toBe(new Date().toISOString().slice(0, 10))
  })

  it('nextResetISO 返 ISO 字符串且对应 UTC 第二天 00:00:00', () => {
    const reset = nextResetISO()
    const d = new Date(reset)
    expect(d.getUTCHours()).toBe(0)
    expect(d.getUTCMinutes()).toBe(0)
    expect(d.getUTCSeconds()).toBe(0)
    expect(d.getTime()).toBeGreaterThan(Date.now())
  })
})

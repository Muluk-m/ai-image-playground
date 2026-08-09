import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import { currentQuotaDate, nextResetISO, tryConsumeQuota } from '../../lib/quota'

const databaseUrl = await resetTestDatabase('bff_quota')
const connection = createDb(databaseUrl)
const { db, schema } = connection

afterAll(async () => {
  await connection.close()
})

beforeEach(async () => {
  await db.delete(schema.daily_quota)
})

describe('tryConsumeQuota', () => {
  it('首次消费写入计数', async () => {
    const result = await tryConsumeQuota('dev-1', 5, db)
    expect(result.ok).toBe(true)
    expect(result.count).toBe(5)
    expect(result.reset_at).toBe(nextResetISO())
  })

  it('累计 8 次 n=10 到达 80', async () => {
    for (let i = 1; i <= 8; i++) {
      const result = await tryConsumeQuota('dev-1', 10, db)
      expect(result.ok).toBe(true)
      expect(result.count).toBe(i * 10)
    }
  })

  it('累计到 80 后第 81 次保持 80', async () => {
    for (let i = 0; i < 8; i++) await tryConsumeQuota('dev-1', 10, db)
    const result = await tryConsumeQuota('dev-1', 1, db)
    expect(result.ok).toBe(false)
    expect(result.count).toBe(80)
  })

  it('单次消费超出剩余额度时保持已有计数', async () => {
    await tryConsumeQuota('dev-1', 78, db)
    const result = await tryConsumeQuota('dev-1', 3, db)
    expect(result.ok).toBe(false)
    expect(result.count).toBe(78)
  })

  it('不同 device_id 各自独立计数', async () => {
    await tryConsumeQuota('dev-1', 80, db)
    const result = await tryConsumeQuota('dev-2', 80, db)
    expect(result.ok).toBe(true)
    expect(result.count).toBe(80)
  })

  it('currentQuotaDate 返 YYYY-MM-DD UTC', () => {
    const date = currentQuotaDate()
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(date).toBe(new Date().toISOString().slice(0, 10))
  })

  it('nextResetISO 返 UTC 第二天零点', () => {
    const reset = new Date(nextResetISO())
    expect(reset.getUTCHours()).toBe(0)
    expect(reset.getUTCMinutes()).toBe(0)
    expect(reset.getUTCSeconds()).toBe(0)
    expect(reset.getTime()).toBeGreaterThan(Date.now())
  })
})

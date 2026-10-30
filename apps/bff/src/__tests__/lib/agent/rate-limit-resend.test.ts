import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

process.env.DATABASE_URL = await resetTestDatabase('bff_rate_limit_resend')
process.env.PORT = '0'

const { close: closeDb, db, schema } = await import('../../../db/client')
const { recentlyRateLimited, recentlyRateLimitedLocked } = await import(
  '../../../lib/agent/rate-limit-resend'
)

const KEY = { conversationId: 'conv-429', model: 'gemini-3.1-flash-lite-image', prompt: '橘猫' }

async function insertRateLimitedFailure(id: string): Promise<void> {
  await db.insert(schema.tasks).values({
    id,
    provider: 'gemini',
    model: KEY.model,
    status: 'failed',
    error_type: 'rate_limited',
    request_payload: { prompt: KEY.prompt, device_id: 'd' },
    agent_conversation_id: KEY.conversationId,
    submitted_at: Date.now(),
    completed_at: Date.now(),
  })
}

beforeEach(async () => {
  await db.delete(schema.tasks)
})

afterAll(async () => {
  await closeDb()
})

describe('限流后不自动重发的检查', () => {
  it('matches only the same conversation, model and prompt', async () => {
    await insertRateLimitedFailure('t1')
    expect(await recentlyRateLimited(KEY)).toBe(true)
    expect(await recentlyRateLimited({ ...KEY, prompt: '别的' })).toBe(false)
    expect(await recentlyRateLimited({ ...KEY, model: 'other' })).toBe(false)
    expect(await recentlyRateLimited({ ...KEY, conversationId: 'other' })).toBe(false)
  })

  it('serializes check-then-create: a waiter re-reads what the holder committed', async () => {
    let releaseHolder!: () => void
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve
    })
    let holderChecked!: () => void
    const holderHasLock = new Promise<void>((resolve) => {
      holderChecked = resolve
    })
    // 第一条提交：拿到锁、检查通过，在同一事务里「建任务」——这里建的是它随后撞 429 的失败行。
    const holder = db.transaction(async (tx) => {
      const limited = await recentlyRateLimitedLocked(tx, KEY)
      holderChecked()
      await holderReleased
      await tx.insert(schema.tasks).values({
        id: 'holder',
        provider: 'gemini',
        model: KEY.model,
        status: 'failed',
        error_type: 'rate_limited',
        request_payload: { prompt: KEY.prompt, device_id: 'd' },
        agent_conversation_id: KEY.conversationId,
        submitted_at: Date.now(),
        completed_at: Date.now(),
      })
      return limited
    })
    await holderHasLock
    let waiterDone = false
    const waiter = db
      .transaction((tx) => recentlyRateLimitedLocked(tx, KEY))
      .finally(() => {
        waiterDone = true
      })
    await Bun.sleep(50)
    // 锁还在第一条手里：第二条停在锁上，没有抢先读到「还没有失败记录」。
    expect(waiterDone).toBe(false)
    releaseHolder()
    expect(await holder).toBe(false)
    expect(await waiter).toBe(true)
  })
})

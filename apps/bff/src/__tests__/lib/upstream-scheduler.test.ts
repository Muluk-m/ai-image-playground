import { afterEach, beforeEach, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

// 配额在公开库上按行锁抢，要一个迁好的库。
process.env.DATABASE_URL = await resetTestDatabase('bff_upstream_scheduler')
process.env.SCHEDULER_NAMESPACE = 'unit'

const {
  _setSchedulerClockForTesting,
  acquireSchedulerSlots,
  coolDownSchedulerBuckets,
  gptSchedulerBuckets,
  heartbeatSchedulerSlots,
  releaseSchedulerSlots,
  schedulerBucketUsage,
  waitForSchedulerSlots,
} = await import('../../lib/upstream/scheduler')
const { db, schema } = await import('../../db/client')

let clock = Date.parse('2026-10-30T12:00:00+08:00')
beforeEach(async () => {
  clock = Date.parse('2026-10-30T12:00:00+08:00')
  _setSchedulerClockForTesting(() => clock)
  await db.delete(schema.scheduler_leases)
  await db.delete(schema.scheduler_buckets)
})
afterEach(() => _setSchedulerClockForTesting())

const perModel = { key: 'm', imagesPerMinute: 16, coolDownOnRateLimit: true }
const inflight = { key: 'inflight', concurrency: 8 }

it('caps images in any rolling minute and says when the oldest images leave the window', async () => {
  for (let i = 0; i < 16; i += 1) {
    expect(await acquireSchedulerSlots(`a${i}`, [perModel], 1)).toEqual({ granted: true })
    await releaseSchedulerSlots(`a${i}`)
    clock += 1_000
  }
  // 第 17 张要等第一张滑出窗口：它在 12:00:00 发出，现在是 12:00:16。
  expect(await acquireSchedulerSlots('a16', [perModel], 1)).toEqual({
    granted: false,
    retryAfterMs: 44_000,
  })
  clock += 44_001
  expect(await acquireSchedulerSlots('a16', [perModel], 1)).toEqual({ granted: true })
  expect((await schedulerBucketUsage('m')).imagesLastMinute).toBe(16)
})

it('deducts native n per image and still lets an oversized batch through an empty window', async () => {
  expect(await acquireSchedulerSlots('n10', [perModel], 10)).toEqual({ granted: true })
  expect((await acquireSchedulerSlots('n7', [perModel], 7)).granted).toBe(false)
  expect(await acquireSchedulerSlots('n6', [perModel], 6)).toEqual({ granted: true })
  clock += 61_000
  expect(await acquireSchedulerSlots('n20', [perModel], 20)).toEqual({ granted: true })
})

it('is idempotent per attempt and refunds images only when the request never went out', async () => {
  expect(await acquireSchedulerSlots('same', [perModel, inflight], 4)).toEqual({ granted: true })
  expect(await acquireSchedulerSlots('same', [perModel, inflight], 4)).toEqual({ granted: true })
  expect(await schedulerBucketUsage('m')).toMatchObject({ inFlight: 1, imagesLastMinute: 4 })
  await releaseSchedulerSlots('same')
  await releaseSchedulerSlots('same')
  expect(await schedulerBucketUsage('m')).toMatchObject({ inFlight: 0, imagesLastMinute: 4 })

  await acquireSchedulerSlots('unsent', [perModel], 3)
  await releaseSchedulerSlots('unsent', { refund: true })
  expect((await schedulerBucketUsage('m')).imagesLastMinute).toBe(4)
})

it('limits requests in flight and grants all buckets or none', async () => {
  const pair = [perModel, { key: 'inflight', concurrency: 2 }]
  expect((await acquireSchedulerSlots('c1', pair, 1)).granted).toBe(true)
  expect((await acquireSchedulerSlots('c2', pair, 1)).granted).toBe(true)
  expect(await acquireSchedulerSlots('c3', pair, 1)).toEqual({ granted: false, retryAfterMs: 500 })
  // 被在途数挡下的请求没有偷偷扣掉每分钟张数。
  expect((await schedulerBucketUsage('m')).imagesLastMinute).toBe(2)
  await releaseSchedulerSlots('c1')
  expect((await acquireSchedulerSlots('c3', pair, 1)).granted).toBe(true)
})

it('reclaims the in-flight slot of a lease whose heartbeat stopped, but keeps its images counted', async () => {
  const one = [{ key: 'inflight', concurrency: 1 }, perModel]
  expect((await acquireSchedulerSlots('dead', one, 1)).granted).toBe(true)
  expect((await acquireSchedulerSlots('alive', one, 1)).granted).toBe(false)
  clock += 45_000
  await heartbeatSchedulerSlots(['dead'])
  clock += 45_000
  // 45 秒前还有心跳：没过 60 秒，不能收。
  expect((await acquireSchedulerSlots('alive', one, 1)).granted).toBe(false)
  clock += 16_000
  expect((await acquireSchedulerSlots('alive', one, 1)).granted).toBe(true)
  expect((await schedulerBucketUsage('m')).imagesLastMinute).toBe(1)
})

it('stops granting a rate-limited bucket until its cooldown ends, and never shortens a cooldown', async () => {
  await coolDownSchedulerBuckets(['m'], 60_000)
  await coolDownSchedulerBuckets(['m'], 10_000)
  expect(await acquireSchedulerSlots('r1', [perModel, inflight], 1)).toEqual({
    granted: false,
    retryAfterMs: 60_000,
  })
  // 其它模型的桶不受影响。
  expect((await acquireSchedulerSlots('r2', [{ ...perModel, key: 'other' }], 1)).granted).toBe(true)
  clock += 60_001
  expect((await acquireSchedulerSlots('r1', [perModel, inflight], 1)).granted).toBe(true)
})

it('never over-grants when many workers race for the same buckets', async () => {
  _setSchedulerClockForTesting()
  const results = await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      acquireSchedulerSlots(`race${i}`, [perModel, inflight], 1),
    ),
  )
  expect(results.filter((result) => result.granted)).toHaveLength(8)
  expect(await schedulerBucketUsage('inflight')).toMatchObject({ inFlight: 8 })
})

it('waits for a slot, gives up on abort without holding anything, and releases once', async () => {
  _setSchedulerClockForTesting()
  const one = [{ key: 'inflight', concurrency: 1 }]
  const first = await waitForSchedulerSlots(one, 1)
  const waiting = waitForSchedulerSlots(one, 1)
  await Bun.sleep(100)
  await first!.release()
  await first!.release()
  const second = await waiting
  expect(second).toBeDefined()

  const controller = new AbortController()
  const third = waitForSchedulerSlots(one, 1, controller.signal)
  controller.abort(new Error('cancelled'))
  await expect(third).rejects.toThrow('cancelled')
  expect((await schedulerBucketUsage('inflight')).inFlight).toBe(1)
  await second!.release()
  expect((await schedulerBucketUsage('inflight')).inFlight).toBe(0)
})

it('keeps namespaces apart', async () => {
  await acquireSchedulerSlots('ns', [{ key: 'inflight', concurrency: 1 }], 1)
  const [row] = await db.select().from(schema.scheduler_buckets)
  expect(row?.key).toBe('unit:inflight')
})

it('maps GPT routes to buckets: direct gets per-model, in-flight and optional org; sub2api caps in flight', () => {
  expect(gptSchedulerBuckets('gpt-image-2', 'direct')).toEqual([
    {
      key: 'openai:direct:model:gpt-image-2',
      imagesPerMinute: 16,
      coolDownOnRateLimit: true,
    },
    { key: 'openai:direct:inflight', concurrency: 8 },
  ])
  expect(gptSchedulerBuckets('gpt-image-2', 'sub2api')).toEqual([
    { key: 'openai:sub2api:inflight', concurrency: 8 },
  ])
})

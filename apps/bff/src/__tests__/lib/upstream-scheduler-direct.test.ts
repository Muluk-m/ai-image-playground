import { afterEach, beforeEach, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

// 模拟上游压测：GPT 走直连（UPSTREAM_BASE_URL 指向 api.openai.com），fetch 换成本地桩，不打真实上游。
process.env.DATABASE_URL = await resetTestDatabase('bff_upstream_scheduler_direct')
process.env.UPSTREAM_BASE_URL = 'https://api.openai.com'
process.env.UPSTREAM_API_KEY = 'test-key'
process.env.SCHEDULER_NAMESPACE = 'direct-test'
process.env.PORT = '0'

const {
  callUpstream,
  setUpstreamFetchForTesting,
  UpstreamQueueTimeoutError,
  UpstreamResultUnknownError,
} = await import('../../lib/upstream')
const { QUEUE_TIMEOUTS } = await import('@image-playground/shared')
const {
  _setSchedulerClockForTesting,
  acquireSchedulerSlots,
  coolDownSchedulerBuckets,
  SCHEDULER_WINDOW_MS,
  schedulerBucketUsage,
} = await import('../../lib/upstream/scheduler')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { db, schema } = await import('../../db/client')
type TestFetch = NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>

/** 测试时钟跑得比真实时间快 60 倍：真实 1 秒 = 模拟 1 分钟。 */
const SPEED = 60
let origin = 0
const simNow = () => origin + (Date.now() - origin) * SPEED

interface Sent {
  model: string
  at: number
}
let sent: Sent[] = []
let inFlight = 0
let maxInFlight = 0
let status = 200

function stubUpstream(latencyMs: number): void {
  setUpstreamFetchForTesting((async (_input: unknown, init?: { body?: unknown }) => {
    const { model } = JSON.parse(String(init?.body)) as { model: string }
    sent.push({ model, at: simNow() })
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await Bun.sleep(latencyMs)
    inFlight -= 1
    return status === 200
      ? new Response(JSON.stringify({ data: [{ b64_json: 'ok' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status })
  }) as unknown as TestFetch)
}

/**
 * 任意 60 秒（模拟时钟）内同一模型发出的最多张数。额度按拿到时计，桩记的是之后真正调 fetch 的时刻，
 * 中间隔着几毫秒事件循环；时钟放大 60 倍后这点抖动够把下一分钟的第一张挤进上一分钟，按 30ms 真实时间扣掉。
 */
const JITTER_MS = 30 * SPEED

function maxImagesPerMinute(model: string): number {
  const times = sent.filter((entry) => entry.model === model).map((entry) => entry.at)
  const window = SCHEDULER_WINDOW_MS - JITTER_MS
  let best = 0
  for (const start of times) {
    best = Math.max(best, times.filter((at) => at >= start && at < start + window).length)
  }
  return best
}

/** 同一模型第一张到最后一张发出的模拟时长。 */
function sendSpan(model: string): number {
  const times = sent.filter((entry) => entry.model === model).map((entry) => entry.at)
  return Math.max(...times) - Math.min(...times)
}

beforeEach(async () => {
  _setChannelsForTesting([])
  origin = Date.now()
  _setSchedulerClockForTesting(simNow, SPEED)
  sent = []
  inFlight = 0
  maxInFlight = 0
  status = 200
  await db.delete(schema.scheduler_leases)
  await db.delete(schema.scheduler_buckets)
})

afterEach(() => {
  setUpstreamFetchForTesting()
  _setSchedulerClockForTesting()
})

it('holds two models to 16 images a minute each and 8 requests in flight across concurrent tasks', async () => {
  stubUpstream(40)
  // 6 个任务（相当于几个 worker 同时在跑），两个模型共 60 张，全部 fan-out 成单张请求。
  const tasks = [
    ...Array.from({ length: 3 }, () => ({ model: 'gpt-image-2', n: 10 })),
    ...Array.from({ length: 3 }, () => ({ model: 'gpt-image-1.5', n: 10 })),
  ]
  const results = await Promise.all(
    tasks.map(({ model, n }) =>
      callUpstream({ provider: 'openai-compat', model, request: { prompt: 'a cat', n } }),
    ),
  )
  for (const result of results) {
    expect((result.payload as { data: unknown[] }).data).toHaveLength(10)
  }
  expect(sent).toHaveLength(60)
  expect(maxInFlight).toBeLessThanOrEqual(8)
  for (const model of ['gpt-image-2', 'gpt-image-1.5']) {
    // 上限只断言「不超过」：CI 机器慢、并行跑测试时一分钟内可能根本发不满 16 张，断言「恰好 16」会随负载抖动。
    expect(maxImagesPerMinute(model)).toBeLessThanOrEqual(16)
    // 限速确实生效：每个模型 30 张，每分钟最多 16 张，第 17 张最早在第一张之后一分钟才能拿到额度。
    // 不限速时 8 路并发、40ms 延迟，30 张在模拟时钟上不到 20 秒就发完。
    expect(sendSpan(model)).toBeGreaterThanOrEqual(SCHEDULER_WINDOW_MS - JITTER_MS)
  }
  expect((await schedulerBucketUsage('openai:direct:inflight')).inFlight).toBe(0)
}, 30_000)

it('cools the model bucket down after a 429 so the next attempt waits instead of hammering', async () => {
  stubUpstream(5)
  status = 429
  await expect(
    callUpstream({ provider: 'openai-compat', model: 'gpt-image-2', request: { prompt: 'x' } }),
  ).rejects.toBeDefined()
  const usage = await schedulerBucketUsage('openai:direct:model:gpt-image-2')
  expect(usage.cooldownUntil).not.toBeNull()
  expect(usage.inFlight).toBe(0)

  status = 200
  const before = simNow()
  await callUpstream({ provider: 'openai-compat', model: 'gpt-image-2', request: { prompt: 'y' } })
  // 第二次请求等到冷却（模拟 60 秒）结束才发出。
  expect(sent[1]!.at - before).toBeGreaterThanOrEqual(55_000)
}, 30_000)

it('refunds the images when the accounting step fails before anything is sent', async () => {
  stubUpstream(5)
  await expect(
    callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: { prompt: 'x' },
      beforeRequest: async () => {
        throw new Error('ledger down')
      },
    }),
  ).rejects.toThrow()
  expect(sent).toHaveLength(0)
  expect(await schedulerBucketUsage('openai:direct:model:gpt-image-2')).toMatchObject({
    inFlight: 0,
    imagesLastMinute: 0,
  })
})

it('times out while queueing as a plain timeout, without holding a slot', async () => {
  stubUpstream(5)
  await coolDownSchedulerBuckets(['openai:direct:model:gpt-image-2'], 3_600_000)
  const controller = new AbortController()
  const pending = callUpstream({
    provider: 'openai-compat',
    model: 'gpt-image-2',
    request: { prompt: 'x' },
    signal: controller.signal,
  })
  await Bun.sleep(100)
  controller.abort()
  await expect(pending).rejects.toBeDefined()
  expect(sent).toHaveLength(0)
  expect((await schedulerBucketUsage('openai:direct:inflight')).inFlight).toBe(0)
})

/** 让硬超时在 ms 毫秒后到：resume 不带上游任务号时只用来算截止时间，不改变发送路径。 */
function expiringIn(ms: number) {
  return { taskIds: [], submittedAt: Date.now() - QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS + ms }
}

it('reports a hard timeout spent entirely in the queue as not executed, so the task fails and refunds', async () => {
  stubUpstream(5)
  await coolDownSchedulerBuckets(['openai:direct:model:gpt-image-2'], 3_600_000)
  const error = await callUpstream({
    provider: 'openai-compat',
    model: 'gpt-image-2',
    request: { prompt: 'x' },
    resume: expiringIn(300),
  }).catch((err: unknown) => err)
  expect(error).toBeInstanceOf(UpstreamQueueTimeoutError)
  // 不是「结果未知」：task-runner 不会把它送去对账（未派发的任务对账不了，会卡在 in_progress）。
  expect(error).not.toBeInstanceOf(UpstreamResultUnknownError)
  expect(sent).toHaveLength(0)
})

it('keeps the result-unknown timeout once any request of the call has been sent', async () => {
  // 一分钟额度只剩 1 张：fan-out 的第一张发出去（上游迟迟不回），第二张一直排队到硬超时。
  stubUpstream(2_000)
  await acquireSchedulerSlots(
    'prefill',
    [{ key: 'openai:direct:model:gpt-image-2', imagesPerMinute: 16 }],
    15,
  )
  const error = await callUpstream({
    provider: 'openai-compat',
    model: 'gpt-image-2',
    request: { prompt: 'x', n: 2 },
    resume: expiringIn(400),
  }).catch((err: unknown) => err)
  expect(sent).toHaveLength(1)
  expect(error).toBeInstanceOf(UpstreamResultUnknownError)
  expect(error).not.toBeInstanceOf(UpstreamQueueTimeoutError)
})

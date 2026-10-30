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
  _setSchedulerSleepForTesting,
  acquireSchedulerSlots,
  coolDownSchedulerBuckets,
  SCHEDULER_WINDOW_MS,
  schedulerBucketUsage,
} = await import('../../lib/upstream/scheduler')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { db, schema } = await import('../../db/client')
const { and, eq, isNull } = await import('drizzle-orm')
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
/** 桩记录发送时刻用的时钟。 */
let stubClock = simNow
let inFlight = 0
let maxInFlight = 0
let status = 200

function stubUpstream(latencyMs: number): void {
  setUpstreamFetchForTesting((async (
    _input: unknown,
    init?: { body?: unknown; signal?: AbortSignal },
  ) => {
    const { model } = JSON.parse(String(init?.body)) as { model: string }
    sent.push({ model, at: stubClock() })
    if (recordGrants) await recordModelGrants(model)
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      // 跟真实 fetch 一样：请求被叫停时立刻以 AbortError 结束，不等上游回包。
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, latencyMs)
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(new DOMException('aborted', 'AbortError'))
          },
          { once: true },
        )
      })
    } finally {
      inFlight -= 1
    }
    return status === 200
      ? new Response(JSON.stringify({ data: [{ b64_json: 'ok' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status })
  }) as unknown as TestFetch)
}

/**
 * 受控时钟：只在调度器「等额度」睡眠时前进，并且要等所有在途租约都还掉才前进，
 * 在途请求的心跳不会被跳过。真实耗时、CI 负载都不影响结果。
 */
let virtualNow = 0
async function openLeases(): Promise<number> {
  const rows = await db
    .select({ key: schema.scheduler_leases.bucket_key })
    .from(schema.scheduler_leases)
    .where(
      and(
        eq(schema.scheduler_leases.bucket_key, 'direct-test:openai:direct:inflight'),
        isNull(schema.scheduler_leases.released_at),
      ),
    )
  return rows.length
}
async function virtualSleep(ms: number, signal?: AbortSignal): Promise<void> {
  const wakeAt = virtualNow + ms
  while ((await openLeases()) > 0) {
    if (signal?.aborted) throw signal.reason
    await Bun.sleep(2)
  }
  virtualNow = Math.max(virtualNow, wakeAt)
  await Bun.sleep(0)
  if (signal?.aborted) throw signal.reason
}

/**
 * 调度器给每张图记下的拿额度时刻（租约的 acquired_at，就是滑动窗口计数用的那个时刻），按 attempt 去重。
 * 每条请求发出时它自己的租约一定还没还，所以在桩里读一遍未还的租约就不会漏；不拿桩被调用时的时钟，
 * 因为别的等待者可能恰在拿额度和发出之间把受控时钟往前拨。
 */
let recordGrants = false
const grants = new Map<string, Map<string, number>>()
async function recordModelGrants(model: string): Promise<void> {
  const rows = await db
    .select({
      attemptId: schema.scheduler_leases.attempt_id,
      acquiredAt: schema.scheduler_leases.acquired_at,
    })
    .from(schema.scheduler_leases)
    .where(
      and(
        eq(schema.scheduler_leases.bucket_key, `direct-test:openai:direct:model:${model}`),
        isNull(schema.scheduler_leases.released_at),
      ),
    )
  const seen = grants.get(model) ?? new Map<string, number>()
  for (const row of rows) seen.set(row.attemptId, row.acquiredAt)
  grants.set(model, seen)
}
const grantTimes = (model: string): number[] => [...(grants.get(model)?.values() ?? [])]

/** 任意 60 秒窗口内拿到的最多张数。 */
function maxPerWindow(times: number[]): number {
  let best = 0
  for (const start of times) {
    best = Math.max(
      best,
      times.filter((at) => at >= start && at < start + SCHEDULER_WINDOW_MS).length,
    )
  }
  return best
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
  _setSchedulerSleepForTesting()
  stubClock = simNow
  recordGrants = false
  grants.clear()
})

it('holds two models to 16 images a minute each and 8 requests in flight across concurrent tasks', async () => {
  virtualNow = 1_000_000
  _setSchedulerClockForTesting(() => virtualNow)
  _setSchedulerSleepForTesting(virtualSleep)
  stubClock = () => virtualNow
  recordGrants = true
  stubUpstream(50)
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
    const times = grantTimes(model)
    expect(times).toHaveLength(30)
    // 第一分钟正好放满 16 张，之后任何 60 秒窗口都不超过 16 张。
    expect(maxPerWindow(times)).toBe(16)
    // 第 17 张要等第 1 张出窗口：30 张至少跨一整分钟。
    expect(Math.max(...times) - Math.min(...times)).toBeGreaterThanOrEqual(SCHEDULER_WINDOW_MS)
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

it('delivers the image already out and refunds the one still queued at the hard timeout', async () => {
  // 一分钟额度只剩 1 张：fan-out 的第一张发出去并很快出图，第二张一直排队到硬超时。
  // 第二张确定没发出，按部分交付：交第一张、记一张缺口，task-runner 只结算交付的那张。
  stubUpstream(5)
  await acquireSchedulerSlots(
    'prefill',
    [{ key: 'openai:direct:model:gpt-image-2', imagesPerMinute: 16 }],
    15,
  )
  const result = await callUpstream({
    provider: 'openai-compat',
    model: 'gpt-image-2',
    request: { prompt: 'x', n: 2 },
    resume: expiringIn(400),
  })
  expect(sent).toHaveLength(1)
  const payload = result.payload as { data: unknown[]; partial_failure: unknown }
  expect(payload.data).toHaveLength(1)
  expect(payload.partial_failure).toEqual({ requested: 2, failed: 1, type: 'upstream_error' })
})

it('keeps the result-unknown timeout when a sent request is still out at the hard timeout', async () => {
  // 一分钟额度只剩 1 张：fan-out 的第一张发出去（上游迟迟不回），第二张一直排队到硬超时。
  // 第二张确定没发，但第一张结果未知：整组按结果未知报，不能当没执行退款。
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

it('treats a deadline that lands just as the slot is granted as not executed', async () => {
  // 截止时间在拿名额的同时到：名额拿到了，但记账回调之前就停下，请求同样没发出。
  stubUpstream(5)
  const error = await callUpstream({
    provider: 'openai-compat',
    model: 'gpt-image-2',
    request: { prompt: 'x' },
    resume: expiringIn(0),
  }).catch((err: unknown) => err)
  expect(error).toBeInstanceOf(UpstreamQueueTimeoutError)
  expect(sent).toHaveLength(0)
})

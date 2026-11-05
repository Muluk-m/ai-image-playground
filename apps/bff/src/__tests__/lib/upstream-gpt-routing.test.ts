import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { SchedulerLease } from '../../lib/upstream/scheduler'

// GPT 两条通道：OpenAI 直连与 sub2api。fetch 换成本地桩，按 host 区分两条路，不打真实上游。
process.env.DATABASE_URL = await resetTestDatabase('bff_upstream_gpt_routing')
process.env.UPSTREAM_BASE_URL = 'https://sub2api.example.com'
process.env.UPSTREAM_API_KEY = 'sub2api-key'
process.env.GPT_DIRECT_ENABLED = 'true'
process.env.OPENAI_API_KEY = 'direct-key'
process.env.OPENAI_ORG_ID = 'org-test'
process.env.GPT_DIRECT_ATTEMPT_TIMEOUT_MS = '300'
process.env.GPT_SUB2API_ATTEMPT_TIMEOUT_MS = '300'
process.env.GPT_SUB2API_BREAKER_FAILURES = '2'
process.env.GPT_DIRECT_MONTHLY_BUDGET_USD = '1'
process.env.SCHEDULER_NAMESPACE = 'routing-test'
process.env.GPT_DIRECT_CONCURRENCY = '1'
process.env.PORT = '0'

// Imports below must observe this suite's database and routing environment, not the host defaults.
const { callUpstream, setUpstreamFetchForTesting, UpstreamResultUnknownError } = await import(
  '../../lib/upstream'
)
const { PROMPT_REWRITE_GUARD_PREFIX } = await import('@image-playground/shared')
const { coolDownSchedulerBuckets } = await import('../../lib/upstream/scheduler')
const { _resetSub2apiBreakerForTesting, sub2apiBreakerOpen } = await import(
  '../../lib/upstream/gpt-routing'
)
const { _resetDirectBudgetCacheForTesting } = await import('../../lib/upstream/gpt-budget')
const { fingerprintOf } = await import('../../lib/upstream/gpt-key-config')
const { ImagePlanRequiredError } = await import('../../lib/upstream/errors')
const { config } = await import('../../config')
const { gptSchedulerBuckets, tryAcquireSchedulerSlots } = await import(
  '../../lib/upstream/scheduler'
)
const { _setChannelsForTesting } = await import('../../lib/channels')
const { db, schema } = await import('../../db/client')
type TestFetch = NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>

const MODEL = 'gpt-image-2.5-flare'
const USAGE = {
  input_tokens: 17,
  input_tokens_details: { image_tokens: 0, text_tokens: 17 },
  output_tokens: 439,
}

interface Sent {
  route: 'direct' | 'sub2api'
  body: Record<string, unknown>
  headers: Record<string, string>
}
let sent: Sent[] = []
let behaviour: Record<'direct' | 'sub2api', { status: number; latencyMs: number }>

function stub(): void {
  setUpstreamFetchForTesting((async (
    input: unknown,
    init?: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal },
  ) => {
    const route = new URL(String(input)).hostname === 'api.openai.com' ? 'direct' : 'sub2api'
    sent.push({
      route,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: init?.headers ?? {},
    })
    const { status, latencyMs } = behaviour[route]
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
    if (status !== 200)
      return new Response(JSON.stringify({ error: { message: `upstream ${status}` } }), { status })
    return new Response(
      JSON.stringify({
        data: [{ b64_json: 'ok' }],
        ...(route === 'direct' ? { usage: USAGE } : {}),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as TestFetch)
}

/** 每条路开跑前记下的通道（task-runner 据此写任务行，结算按最后一条判断降档）。 */
let routes: string[] = []
const call = (request: Record<string, unknown>, member: boolean, strictImageRequest = false) =>
  callUpstream({
    provider: 'openai-compat',
    model: MODEL,
    taskId: 'task-1',
    gptMember: member,
    strictImageRequest,
    request: { prompt: 'a cat', ...request },
    onGptRoute: async (route) => {
      routes.push(route)
    },
  })

beforeEach(async () => {
  _setChannelsForTesting([])
  _resetSub2apiBreakerForTesting()
  _resetDirectBudgetCacheForTesting()
  sent = []
  routes = []
  behaviour = { direct: { status: 200, latencyMs: 5 }, sub2api: { status: 200, latencyMs: 5 } }
  stub()
  await db.delete(schema.scheduler_leases)
  await db.delete(schema.scheduler_buckets)
  await db.delete(schema.gpt_direct_usage)
  await db.delete(schema.gpt_direct_key_state)
})

afterEach(() => setUpstreamFetchForTesting())

describe('route choice', () => {
  it('sends members to OpenAI direct with native parameters and records the cost from usage', async () => {
    const guarded = `${PROMPT_REWRITE_GUARD_PREFIX}\na cat\n\nComposition: a wide 16:9 landscape frame, horizontal orientation.`
    await call({ prompt: guarded, size: '2560x1440', quality: 'auto' }, true)

    expect(sent.map((one) => one.route)).toEqual(['direct'])
    // 直连认原生参数：剥掉提交时钉上的机器指令，auto 改发 medium。
    expect(sent[0]!.body).toMatchObject({
      model: MODEL,
      prompt: 'a cat',
      size: '2560x1440',
      quality: 'medium',
    })
    expect(sent[0]!.headers).toMatchObject({
      authorization: 'Bearer direct-key',
      'openai-organization': 'org-test',
    })
    expect(routes.at(-1)).toBe('direct')

    const [usage] = await db.select().from(schema.gpt_direct_usage)
    // 17 × $5/M + 439 × $30/M = 85 + 13170 微美元。
    expect(usage).toMatchObject({
      task_id: 'task-1',
      model: MODEL,
      images: 1,
      output_tokens: 439,
      cost_micro_usd: 13_255,
      estimated: false,
      key_fingerprint: fingerprintOf('direct-key').fingerprint,
    })
    expect(JSON.stringify(usage)).not.toContain('direct-key')
  })

  it('sends non-members to sub2api with the ratio written into the prompt', async () => {
    await call({ size: '1280x720' }, false)
    expect(sent.map((one) => one.route)).toEqual(['sub2api'])
    expect(sent[0]!.body.prompt).toBe(
      'a cat\n\nComposition: a wide 16:9 landscape frame, horizontal orientation.',
    )
    expect(routes.at(-1)).toBe('sub2api')
    expect(await db.select().from(schema.gpt_direct_usage)).toHaveLength(0)
  })

  it('moves a member to sub2api at once when direct is cooling down, and records sub2api as the route', async () => {
    await coolDownSchedulerBuckets([`openai:direct:model:${MODEL}`], 3_600_000)
    await call({ size: '2048x2048', quality: 'high' }, true)
    expect(sent.map((one) => one.route)).toEqual(['sub2api'])
    expect(routes.at(-1)).toBe('sub2api')
  })

  it('moves a member to sub2api when this month would go over the direct budget', async () => {
    await db.insert(schema.gpt_direct_usage).values({
      id: 'spent',
      model: MODEL,
      images: 1,
      cost_micro_usd: 999_000,
      estimated: false,
      created_at: Date.now(),
    })
    await call({}, true)
    expect(sent.map((one) => one.route)).toEqual(['sub2api'])
  })
})

describe('strict premium CLI routing', () => {
  const premium = { size: '2048x2048', quality: 'medium' }

  it.each([
    { size: '2048x2048', quality: 'medium' },
    { size: '3840x2160', quality: 'medium' },
    { size: '1024x1024', quality: 'high' },
  ])('refuses unavailable direct capacity without dispatching %j', async (request) => {
    await coolDownSchedulerBuckets([`openai:direct:model:${MODEL}`], 3_600_000)
    await expect(call(request, true, true)).rejects.toBeInstanceOf(ImagePlanRequiredError)
    expect(sent).toEqual([])
    expect(routes).toEqual([])
  })

  it('rejects exhausted direct budget instead of invoking sub2api', async () => {
    await db.insert(schema.gpt_direct_usage).values({
      id: 'strict-spent',
      model: MODEL,
      images: 1,
      cost_micro_usd: 999_000,
      estimated: false,
      created_at: Date.now(),
    })
    await expect(call(premium, true, true)).rejects.toBeInstanceOf(ImagePlanRequiredError)
    expect(sent).toEqual([])
  })

  it.each([
    'concurrency',
    'rate',
  ] as const)('rejects exhausted direct %s capacity', async (limit) => {
    const buckets = gptSchedulerBuckets(MODEL, 'direct')
    const images = limit === 'rate' ? config.scheduler.gpt.directImagesPerMinute : 1
    const lease = await tryAcquireSchedulerSlots(buckets, images)
    expect(lease).not.toBeNull()
    try {
      if (limit === 'rate') await lease!.release()
      await expect(call(premium, true, true)).rejects.toBeInstanceOf(ImagePlanRequiredError)
      expect(sent).toEqual([])
    } finally {
      await lease!.release({ refund: true })
    }
  })

  it('rejects capacity stolen after route selection before making any upstream request', async () => {
    const held: { lease: SchedulerLease | null } = { lease: null }
    try {
      await expect(
        callUpstream({
          provider: 'openai-compat',
          model: MODEL,
          strictImageRequest: true,
          request: { prompt: 'a cat', ...premium },
          onGptRoute: async () => {
            held.lease = await tryAcquireSchedulerSlots(gptSchedulerBuckets(MODEL, 'direct'), 1)
          },
        }),
      ).rejects.toBeInstanceOf(ImagePlanRequiredError)
      expect(sent).toEqual([])
    } finally {
      if (held.lease) await held.lease.release({ refund: true })
    }
  })

  it('preserves direct validation errors instead of misclassifying them as a plan rejection', async () => {
    behaviour.direct.status = 400
    const error = await call(premium, true, true).catch((reason: unknown) => reason)
    expect(error).not.toBeInstanceOf(ImagePlanRequiredError)
    expect(error).toMatchObject({ upstreamStatus: 400 })
    expect(sent.map((one) => one.route)).toEqual(['direct'])
  })

  it.each([
    429, 503,
  ])('never fails over after a definitive direct HTTP %s failure', async (status) => {
    behaviour.direct.status = status
    await expect(call(premium, true, true)).rejects.toBeInstanceOf(ImagePlanRequiredError)
    expect(sent.map((one) => one.route)).toEqual(['direct'])
    expect(routes).toEqual(['direct'])
  })

  it('lets strict direct requests finish beyond the failover timer without changing parameters', async () => {
    behaviour.direct.latencyMs = 450
    await call(premium, true, true)
    expect(sent.map((one) => one.route)).toEqual(['direct'])
    expect(sent[0]!.body).toMatchObject(premium)
  })

  it('preserves unknown-result semantics without a fallback request', async () => {
    let requests = 0
    setUpstreamFetchForTesting(async () => {
      requests += 1
      throw new Error('connection lost after dispatch')
    })
    await expect(call(premium, true, true)).rejects.toBeInstanceOf(UpstreamResultUnknownError)
    expect(requests).toBe(1)
    expect(routes).toEqual(['direct'])
  })

  it('keeps basic CLI requests on the existing fallback policy', async () => {
    behaviour.direct.status = 503
    await call({ size: '1024x1024', quality: 'medium' }, true, true)
    expect(sent.map((one) => one.route)).toEqual(['direct', 'sub2api'])
  })
})

describe('failover', () => {
  it('retries a member on sub2api once when direct answers 5xx, without recording direct cost', async () => {
    behaviour.direct.status = 503
    await call({}, true)
    expect(sent.map((one) => one.route)).toEqual(['direct', 'sub2api'])
    expect(routes).toEqual(['direct', 'sub2api'])
    expect(routes.at(-1)).toBe('sub2api')
    expect(await db.select().from(schema.gpt_direct_usage)).toHaveLength(0)
  })

  it('switches to sub2api when direct runs past the attempt timeout, and charges the platform an estimate', async () => {
    behaviour.direct.latencyMs = 5_000
    await call({}, true)
    expect(sent.map((one) => one.route)).toEqual(['direct', 'sub2api'])
    expect(routes.at(-1)).toBe('sub2api')
    const [usage] = await db.select().from(schema.gpt_direct_usage)
    expect(usage).toMatchObject({ estimated: true, output_tokens: null })
  })

  it('lets a non-member borrow direct when sub2api runs past the attempt timeout', async () => {
    behaviour.sub2api.latencyMs = 5_000
    await call({}, false)
    expect(sent.map((one) => one.route)).toEqual(['sub2api', 'direct'])
    expect(routes.at(-1)).toBe('direct')
  })

  it('does not move a non-member off a failing sub2api, but opens the breaker so the next order borrows direct', async () => {
    behaviour.sub2api.status = 502
    await expect(call({}, false)).rejects.toBeDefined()
    await expect(call({}, false)).rejects.toBeDefined()
    expect(sent.map((one) => one.route)).toEqual(['sub2api', 'sub2api'])
    expect(sub2apiBreakerOpen()).toBe(true)

    sent = []
    await call({}, false)
    expect(sent.map((one) => one.route)).toEqual(['direct'])
    expect(routes.at(-1)).toBe('direct')
  })

  it('keeps a fan-out that already delivered an image instead of switching at the attempt timeout', async () => {
    // 第一张很快出，第二张卡住：不能掐掉整单重出，丢掉已出、已计费的那张。
    const { setUpstreamFetchForTesting: setFetch } = await import('../../lib/upstream')
    let count = 0
    setFetch((async (_input: unknown, init?: { signal?: AbortSignal }) => {
      count += 1
      const latency = count === 1 ? 5 : 900
      sent.push({ route: 'sub2api', body: {}, headers: {} })
      await new Promise((resolve) => setTimeout(resolve, latency))
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return new Response(JSON.stringify({ data: [{ b64_json: `ok-${count}` }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as never)
    const result = await call({ n: 2 }, false)
    expect((result.payload as { data: unknown[] }).data).toHaveLength(2)
    expect(routes).toEqual(['sub2api'])
  })

  it('reports an unknown result, not a retryable error, when the first route timed out and the second fails', async () => {
    behaviour.direct.latencyMs = 5_000
    behaviour.sub2api.status = 503
    const error = await call({}, true).catch((err: unknown) => err)
    expect(sent.map((one) => one.route)).toEqual(['direct', 'sub2api'])
    expect(error).toBeInstanceOf(UpstreamResultUnknownError)
    expect((error as { upstreamStatus?: number }).upstreamStatus).toBeUndefined()
  })

  it('does not switch on a client error', async () => {
    behaviour.direct.status = 400
    await expect(call({}, true)).rejects.toBeDefined()
    expect(sent.map((one) => one.route)).toEqual(['direct'])
  })
})

describe('fan-out usage', () => {
  it('adds up usage from every single-image response so the direct cost covers the whole order', async () => {
    // 直连图生图不接受 n，逐张发；两张各回一份 usage，成本按两份之和记。
    const { _callUpstreamDirectForTesting } = await import('../../lib/upstream')
    const result = await _callUpstreamDirectForTesting(
      { provider: 'openai-compat', model: MODEL, request: { prompt: 'a cat', n: 2 } },
      { nativeN: false },
    )
    expect((result.payload as { usage?: unknown }).usage).toEqual({
      input_tokens: 34,
      output_tokens: 878,
      input_tokens_details: { image_tokens: 0, text_tokens: 34 },
    })
  })
})

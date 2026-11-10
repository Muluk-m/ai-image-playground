import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { SchedulerLease } from '../../lib/upstream/scheduler'

// GPT 两条通道：OpenAI 直连与 sub2api。fetch 换成本地桩，按 host 区分两条路，不打真实上游。
process.env.DATABASE_URL = await resetTestDatabase('bff_upstream_gpt_routing')
process.env.UPSTREAM_BASE_URL = 'https://sub2api.example.com'
process.env.UPSTREAM_API_KEY = 'sub2api-key'
process.env.GPT_DIRECT_ENABLED = 'true'
process.env.GPT_IMAGE_26_ENABLED = 'true'
process.env.OPENAI_API_KEY = 'direct-key'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
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
const {
  _resetDirectBudgetCacheForTesting,
  _setBeforeDirectUsageRecordForTesting,
  reserveDirectBudget,
} = await import('../../lib/upstream/gpt-budget')
const { fingerprintOf, envDirectKeys, noteDirectKeySnapshot, resetAdminDirectKeySnapshot } =
  await import('../../lib/upstream/gpt-key-config')
const { GptImage26RouteUnavailableError, ImagePlanRequiredError } = await import(
  '../../lib/upstream/errors'
)
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
  url?: string
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
      url: String(input),
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
    onGptKey: async (fingerprint) => {
      expect(fingerprint === null || fingerprint === fingerprintOf('direct-key').fingerprint).toBe(
        true,
      )
      expect(fingerprint ?? '').not.toContain('direct-key')
    },
  })

beforeEach(async () => {
  resetAdminDirectKeySnapshot()
  _setChannelsForTesting([])
  _resetSub2apiBreakerForTesting()
  _resetDirectBudgetCacheForTesting()
  sent = []
  routes = []
  behaviour = { direct: { status: 200, latencyMs: 5 }, sub2api: { status: 200, latencyMs: 5 } }
  stub()
  await db.delete(schema.scheduler_leases)
  await db.delete(schema.scheduler_buckets)
  await db.delete(schema.gpt_direct_budget_holds)
  await db.delete(schema.gpt_direct_usage)
  await db.delete(schema.gpt_direct_key_state)
  _setBeforeDirectUsageRecordForTesting()
})

afterEach(() => {
  resetAdminDirectKeySnapshot()
  setUpstreamFetchForTesting()
  _setBeforeDirectUsageRecordForTesting()
})

describe('route choice', () => {
  it('skips direct using the hard-disabled snapshot and resumes after a refreshed restore', async () => {
    const keys = envDirectKeys()
    noteDirectKeySnapshot({
      admin: keys,
      hardDisabled: new Set(keys.map((key) => key.fingerprint)),
    })
    await call({}, true)
    expect(sent.map((request) => request.route)).toEqual(['sub2api'])
    noteDirectKeySnapshot({ admin: keys, hardDisabled: new Set() })
    sent = []
    await call({}, true)
    expect(sent.map((request) => request.route)).toEqual(['direct'])
  })

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

  it.each([
    'gpt-image-2.6-flare',
    'gpt-image-2.6-sunburst',
  ])('records the actual %s direct key and removes a legacy guard', async (model) => {
    const fingerprints: string[] = []
    await callUpstream({
      provider: 'openai-compat',
      model,
      request: { prompt: `${PROMPT_REWRITE_GUARD_PREFIX}\na cat`, quality: 'high' },
      onGptKey: async (fingerprint) => {
        fingerprints.push(fingerprint)
      },
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.route).toBe('direct')
    expect(sent[0]!.body).toMatchObject({ prompt: 'a cat', quality: 'high', model })
    expect(fingerprints).toEqual([fingerprintOf('direct-key').fingerprint])
    expect(JSON.stringify(fingerprints)).not.toContain('direct-key')
  })

  it.each([
    'gpt-image-2.6-flare',
    'gpt-image-2.6-sunburst',
  ])('sends a still %s to sub2api while every key is disabled, then back to direct', async (model) => {
    const keys = envDirectKeys()
    for (const automatic of [false, true]) {
      sent = []
      noteDirectKeySnapshot({
        admin: keys.map((key) => ({ ...key, enabled: automatic })),
        hardDisabled: automatic ? new Set(keys.map((key) => key.fingerprint)) : new Set(),
      })
      await callUpstream({ provider: 'openai-compat', model, request: { prompt: 'a cat' } })
      expect(sent.map((request) => request.route)).toEqual(['sub2api'])
      expect(sent[0]?.body.model).toBe(model)
    }
    sent = []
    noteDirectKeySnapshot({ admin: keys, hardDisabled: new Set() })
    await callUpstream({ provider: 'openai-compat', model, request: { prompt: 'a cat' } })
    expect(sent.map((request) => request.route)).toEqual(['direct'])
  })

  it('adds the guard only to the selected gateway when requested', async () => {
    await call({ no_rewrite: true }, false)
    expect(sent[0]!.body.prompt).toBe(`${PROMPT_REWRITE_GUARD_PREFIX}\na cat`)
    expect(sent[0]!.body).not.toHaveProperty('no_rewrite')
    sent = []
    await call({ no_rewrite: true }, true)
    expect(sent[0]!.body.prompt).toBe('a cat')
    expect(sent[0]!.body).not.toHaveProperty('no_rewrite')
  })

  it('sends a non-member 2K request to direct first, and falls back to sub2api when direct is down', async () => {
    await call({ size: '2048x2048', quality: 'medium' }, false)
    expect(sent.map((one) => one.route)).toEqual(['direct'])
    expect(sent[0]!.body).toMatchObject({ size: '2048x2048', quality: 'medium' })

    sent = []
    await coolDownSchedulerBuckets([`openai:direct:model:${MODEL}`], 3_600_000)
    await call({ size: '2560x1440', quality: 'low' }, false)
    expect(sent.map((one) => one.route)).toEqual(['sub2api'])
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
    await call({ no_rewrite: true }, true)
    expect(sent.map((one) => one.route)).toEqual(['direct', 'sub2api'])
    expect(sent.map((one) => one.body.prompt)).toEqual([
      'a cat',
      `${PROMPT_REWRITE_GUARD_PREFIX}\na cat`,
    ])
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
    await call({ no_rewrite: true }, false)
    expect(sent.map((one) => one.route)).toEqual(['sub2api', 'direct'])
    expect(sent.map((one) => one.body.prompt)).toEqual([
      `${PROMPT_REWRITE_GUARD_PREFIX}\na cat`,
      'a cat',
    ])
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

  it('keeps an unknown sub2api dispatch when the direct fallback then fails', async () => {
    behaviour.sub2api.latencyMs = 5_000
    behaviour.direct.status = 500
    const error = await call({}, false).catch((err: unknown) => err)
    expect(sent.map((one) => one.route)).toEqual(['sub2api', 'direct'])
    expect(error).toBeInstanceOf(UpstreamResultUnknownError)
    expect((error as { upstreamStatus?: number }).upstreamStatus).toBeUndefined()
  })

  it('keeps the direct reservation until the unknown dispatch is recorded', async () => {
    const fingerprint = fingerprintOf('direct-key').fingerprint
    let overlap: string | null = 'not-called'
    _setBeforeDirectUsageRecordForTesting(async () => {
      overlap = await reserveDirectBudget({
        fingerprint,
        includeUnattributed: true,
        estimateMicroUsd: 1_000_000,
        capMicroUsd: 1_000_000,
      })
    })
    setUpstreamFetchForTesting((async (input: unknown) => {
      const route = new URL(String(input)).hostname === 'api.openai.com' ? 'direct' : 'sub2api'
      sent.push({ route, body: {}, headers: {} })
      if (route === 'direct') throw new Error('connection lost after dispatch')
      return new Response(JSON.stringify({ error: { message: 'upstream 500' } }), { status: 500 })
    }) as unknown as TestFetch)
    const error = await call({}, true).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(UpstreamResultUnknownError)
    expect(overlap).toBeNull()
    const usage = await db.select().from(schema.gpt_direct_usage)
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ estimated: true, key_fingerprint: fingerprint })
    expect(await db.select().from(schema.gpt_direct_budget_holds)).toHaveLength(0)
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

describe('gpt image 2.6 routes', () => {
  const still = {
    prompt: 'a paper crane',
    output_format: 'png',
    size: '1024x1024',
    quality: 'low',
    n: 1,
  }
  const call26 = (
    request: {
      prompt: string
      output_format?: string
      size?: string
      quality?: string
      n?: number
      frame_count?: number
      frame_duration_ms?: number
      input_images?: string[]
    } = still,
  ) =>
    callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2.6-flare',
      taskId: 'task-26',
      request,
      onGptRoute: async (route) => {
        routes.push(route)
      },
    })

  it('keeps a still image on direct when a key can take it', async () => {
    await call26()
    expect(sent.map((one) => one.route)).toEqual(['direct'])
    expect(routes).toEqual(['direct'])
    expect(sent[0]?.body.model).toBe('gpt-image-2.6-flare')
    expect(sent[0]?.url).toContain('api.openai.com')
    const usage = await db.select().from(schema.gpt_direct_usage)
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({
      model: 'gpt-image-2.6-flare',
      key_fingerprint: fingerprintOf('direct-key').fingerprint,
    })
    expect(JSON.stringify(usage)).not.toContain('direct-key')
  })

  it('sends a still image to sub2api generations when the direct key is disabled', async () => {
    const keys = envDirectKeys()
    noteDirectKeySnapshot({
      admin: keys,
      hardDisabled: new Set(keys.map((key) => key.fingerprint)),
    })
    const responses = config.upstream.imageResponsesModel
    config.upstream.imageResponsesModel = 'gpt-6-astra'
    try {
      await call26()
      expect(sent.map((one) => one.route)).toEqual(['sub2api'])
      expect(routes).toEqual(['sub2api'])
      expect(sent[0]?.body).toMatchObject({
        model: 'gpt-image-2.6-flare',
        size: '1024x1024',
        quality: 'low',
        output_format: 'png',
      })
      expect(sent[0]?.url).toContain('/images/generations')
      expect(sent[0]?.url).not.toContain('responses')
      expect(await db.select().from(schema.gpt_direct_usage)).toHaveLength(0)
    } finally {
      config.upstream.imageResponsesModel = responses
    }
  })

  it('sends a still image to the configured sub2api model when the monthly budget is spent', async () => {
    await db.insert(schema.gpt_direct_usage).values({
      id: 'image-26-spent',
      model: 'gpt-image-2.6-flare',
      images: 1,
      cost_micro_usd: 999_000,
      estimated: false,
      created_at: Date.now(),
    })
    const models = config.gptImage26.sub2apiModels
    const saved = models['gpt-image-2.6-flare']
    models['gpt-image-2.6-flare'] = 'gateway-gpt-image-2.6-flare'
    try {
      await call26()
      expect(sent.map((one) => one.route)).toEqual(['sub2api'])
      expect(sent[0]?.body.model).toBe('gateway-gpt-image-2.6-flare')
      expect(await db.select().from(schema.gpt_direct_usage)).toHaveLength(1)
    } finally {
      models['gpt-image-2.6-flare'] = saved
    }
  })

  it('degrades a 2K or high-quality still onto sub2api when direct is down', async () => {
    const keys = envDirectKeys()
    noteDirectKeySnapshot({
      admin: keys.map((key) => ({ ...key, enabled: false })),
    })
    await call26({
      prompt: 'a paper crane',
      output_format: 'png',
      size: '2048x2048',
      quality: 'low',
      n: 1,
    })
    expect(sent.at(-1)?.route).toBe('sub2api')
    expect(sent.at(-1)?.body).toMatchObject({
      size: '1024x1024',
      quality: 'low',
      output_format: 'png',
    })
    sent = []
    routes = []
    await call26({
      prompt: 'a paper crane',
      output_format: 'png',
      size: '1024x1024',
      quality: 'high',
      n: 1,
    })
    expect(sent[0]?.body).toMatchObject({ size: '1024x1024', quality: 'medium' })
    expect(routes).toEqual(['sub2api'])
  })

  it('sends sunburst to sub2api under its own model name when the direct switch is off', async () => {
    const saved = process.env.GPT_DIRECT_ENABLED
    process.env.GPT_DIRECT_ENABLED = 'false'
    noteDirectKeySnapshot({ admin: null })
    try {
      const before = (await db.select().from(schema.gpt_direct_usage)).length
      await callUpstream({
        provider: 'openai-compat',
        model: 'gpt-image-2.6-sunburst',
        taskId: 'task-sunburst',
        request: still,
        onGptRoute: async (route) => {
          routes.push(route)
        },
      })
      expect(sent.map((one) => one.route)).toEqual(['sub2api'])
      expect(sent[0]?.body.model).toBe('gpt-image-2.6-sunburst')
      expect(routes).toEqual(['sub2api'])
      expect(await db.select().from(schema.gpt_direct_usage)).toHaveLength(before)
    } finally {
      if (saved === undefined) delete process.env.GPT_DIRECT_ENABLED
      else process.env.GPT_DIRECT_ENABLED = saved
    }
  })

  it('opens the sub2api breaker from a 2.6 fallback failure and then stops calling it', async () => {
    const keys = envDirectKeys()
    noteDirectKeySnapshot({
      admin: keys.map((key) => ({ ...key, enabled: false })),
    })
    behaviour.sub2api.status = 502
    await expect(call26()).rejects.toThrow()
    await expect(call26()).rejects.toThrow()
    expect(sub2apiBreakerOpen()).toBe(true)
    sent = []
    await expect(call26()).rejects.toBeInstanceOf(GptImage26RouteUnavailableError)
    expect(sent).toEqual([])
  })

  it('degrades a GIF to a still sub2api image when direct cannot take it', async () => {
    const keys = envDirectKeys()
    noteDirectKeySnapshot({
      admin: keys.map((key) => ({ ...key, enabled: false })),
    })
    await call26({
      prompt: 'a bouncing ball',
      output_format: 'gif',
      size: '768x768',
      frame_count: 6,
      frame_duration_ms: 200,
      n: 1,
    })
    expect(sent[0]?.route).toBe('sub2api')
    expect(sent[0]?.body).toMatchObject({
      output_format: 'png',
      size: '1024x1024',
    })
    expect(sent[0]?.body.frame_count).toBeUndefined()
    expect(sent[0]?.body.frame_duration_ms).toBeUndefined()
    expect(routes).toEqual(['sub2api'])
  })

  it('polls a resumed direct task on OpenAI and does not rewrite the route', async () => {
    setUpstreamFetchForTesting((async (input: unknown) => {
      sent.push({
        route: new URL(String(input)).hostname === 'api.openai.com' ? 'direct' : 'sub2api',
        url: String(input),
        body: {},
        headers: {},
      })
      return new Response(JSON.stringify({ status: 'completed', data: [{ b64_json: 'ok' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as TestFetch)
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2.6-flare',
      request: { prompt: 'a cat', output_format: 'png' },
      persistedGptRoute: 'direct',
      resume: { taskIds: ['resp_direct'], submittedAt: Date.now(), invocationCount: 1 },
      onGptRoute: async (route) => {
        routes.push(route)
      },
    }).catch(() => undefined)
    expect(sent[0]?.route).toBe('direct')
    expect(sent[0]?.url).toContain('api.openai.com')
    expect(routes).toEqual([])
  })

  it('polls a resumed sub2api task on the gateway only when that route was stored', async () => {
    setUpstreamFetchForTesting((async (input: unknown) => {
      sent.push({
        route: new URL(String(input)).hostname === 'api.openai.com' ? 'direct' : 'sub2api',
        url: String(input),
        body: {},
        headers: {},
      })
      return new Response(JSON.stringify({ status: 'completed', data: [{ b64_json: 'ok' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as TestFetch)
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2.6-flare',
      request: { prompt: 'a cat', output_format: 'png' },
      persistedGptRoute: null,
      resume: { taskIds: ['resp_unknown'], submittedAt: Date.now(), invocationCount: 1 },
    }).catch(() => undefined)
    expect(sent[0]?.route).toBe('direct')
    sent = []
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2.6-flare',
      request: { prompt: 'a cat', output_format: 'png' },
      persistedGptRoute: 'sub2api',
      resume: { taskIds: ['resp_gateway'], submittedAt: Date.now(), invocationCount: 1 },
      onGptRoute: async (route) => {
        routes.push(route)
      },
    }).catch(() => undefined)
    expect(sent[0]?.route).toBe('sub2api')
    expect(sent[0]?.url).toContain('sub2api.example.com')
    expect(routes).toEqual([])
  })

  it('reapplies Image 2.6 degrade when a sub2api task resumes', async () => {
    const degraded: { kind: string }[] = []
    setUpstreamFetchForTesting((async (input: unknown, init?: { body?: unknown }) => {
      const url = String(input)
      sent.push({
        route: new URL(url).hostname === 'api.openai.com' ? 'direct' : 'sub2api',
        url,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        headers: {},
      })
      if (url.endsWith('/async')) {
        return new Response(JSON.stringify({ task_id: 'imgtask_new', status: 'processing' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ status: 'completed', data: [{ b64_json: 'ok' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as TestFetch)
    const request = {
      prompt: 'a bouncing ball',
      output_format: 'gif' as const,
      size: '2048x2048',
      quality: 'high' as const,
      frame_count: 12,
      frame_duration_ms: 100,
      n: 1,
    }
    const result = await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2.6-flare',
      request,
      persistedGptRoute: 'sub2api',
      resume: { taskIds: ['imgtask_gif'], submittedAt: Date.now(), invocationCount: 1 },
      onGptRoute: async (route) => {
        routes.push(route)
      },
      onImage26Degrade: async (record) => {
        degraded.push(record)
      },
    })
    expect(routes).toEqual([])
    expect(degraded.map((record) => record.kind)).toEqual(['size_quality_format'])
    expect(sent.every((one) => one.route === 'sub2api')).toBe(true)
    expect(sent.some((one) => one.url?.includes('api.openai.com'))).toBe(false)
    expect(result.payload).toMatchObject({ output_format: 'png', data: [{ b64_json: 'ok' }] })
    expect(await db.select().from(schema.gpt_direct_usage)).toHaveLength(0)

    sent = []
    degraded.length = 0
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2.6-flare',
      request,
      persistedGptRoute: 'sub2api',
      resume: {
        taskIds: ['imgtask_gif'],
        submittedAt: Date.now(),
        invocationCount: 2,
      },
      onGptRoute: async (route) => {
        routes.push(route)
      },
      onImage26Degrade: async (record) => {
        degraded.push(record)
      },
    })
    const posted = sent.filter((one) => one.url?.endsWith('/async'))
    expect(posted).toHaveLength(1)
    expect(posted[0]?.body).toMatchObject({
      size: '1024x1024',
      quality: 'medium',
      output_format: 'png',
    })
    expect(posted[0]?.body.frame_count).toBeUndefined()
    expect(posted[0]?.body.frame_duration_ms).toBeUndefined()
    expect(posted[0]?.body.svg).toBeUndefined()
    expect(routes).toEqual([])
    expect(degraded.map((record) => record.kind)).toEqual(['size_quality_format'])
  })

  it('records the direct route before the request is sent', async () => {
    let routeSettled = false
    setUpstreamFetchForTesting((async (input: unknown) => {
      sent.push({
        route: routeSettled ? 'direct' : 'sub2api',
        url: String(input),
        body: {},
        headers: {},
      })
      return new Response(JSON.stringify({ data: [{ b64_json: 'ok' }], usage: USAGE }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as TestFetch)
    await callUpstream({
      provider: 'openai-compat',
      model: 'gpt-image-2.6-flare',
      request: still,
      onGptRoute: async () => {
        await Promise.resolve()
        routeSettled = true
      },
    })
    expect(sent[0]?.route).toBe('direct')
  })

  it('keeps the direct budget when a later image fails after one was produced', async () => {
    let calls = 0
    setUpstreamFetchForTesting((async (input: unknown) => {
      calls += 1
      sent.push({
        route: new URL(String(input)).hostname === 'api.openai.com' ? 'direct' : 'sub2api',
        url: String(input),
        body: {},
        headers: {},
      })
      if (calls === 1) {
        return new Response(JSON.stringify({ data: [{ b64_json: 'ok' }], usage: USAGE }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ error: { message: 'upstream 500' } }), { status: 500 })
    }) as unknown as TestFetch)
    await expect(
      callUpstream({
        provider: 'openai-compat',
        model: 'gpt-image-2.6-flare',
        reconciliationRequired: true,
        request: {
          prompt: 'a paper crane',
          output_format: 'png',
          size: '1024x1024',
          quality: 'low',
          n: 2,
          input_images: [
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          ],
        },
      }),
    ).rejects.toThrow()
    expect(calls).toBeGreaterThan(1)
    expect(sent.every((one) => one.route === 'direct')).toBe(true)
    expect(await db.select().from(schema.gpt_direct_usage)).toHaveLength(1)
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

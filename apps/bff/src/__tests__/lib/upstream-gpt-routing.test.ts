import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

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
process.env.PORT = '0'

const { callUpstream, setUpstreamFetchForTesting } = await import('../../lib/upstream')
const { PROMPT_REWRITE_GUARD_PREFIX } = await import('@image-playground/shared')
const { coolDownSchedulerBuckets } = await import('../../lib/upstream/scheduler')
const { _resetSub2apiBreakerForTesting, sub2apiBreakerOpen } = await import(
  '../../lib/upstream/gpt-routing'
)
const { _resetDirectBudgetCacheForTesting } = await import('../../lib/upstream/gpt-budget')
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

const call = (request: Record<string, unknown>, member: boolean) =>
  callUpstream({
    provider: 'openai-compat',
    model: MODEL,
    taskId: 'task-1',
    gptMember: member,
    request: { prompt: 'a cat', ...request },
  })

const routeOf = (payload: unknown) => (payload as { gpt_route?: unknown }).gpt_route

beforeEach(async () => {
  _setChannelsForTesting([])
  _resetSub2apiBreakerForTesting()
  _resetDirectBudgetCacheForTesting()
  sent = []
  behaviour = { direct: { status: 200, latencyMs: 5 }, sub2api: { status: 200, latencyMs: 5 } }
  stub()
  await db.delete(schema.scheduler_leases)
  await db.delete(schema.scheduler_buckets)
  await db.delete(schema.gpt_direct_usage)
})

afterEach(() => setUpstreamFetchForTesting())

describe('route choice', () => {
  it('sends members to OpenAI direct with native parameters and records the cost from usage', async () => {
    const guarded = `${PROMPT_REWRITE_GUARD_PREFIX}\na cat\n\nComposition: a wide 16:9 landscape frame, horizontal orientation.`
    const result = await call({ prompt: guarded, size: '2560x1440', quality: 'auto' }, true)

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
    expect(routeOf(result.payload)).toEqual({ route: 'direct', degraded: false })

    const [usage] = await db.select().from(schema.gpt_direct_usage)
    // 17 × $5/M + 439 × $30/M = 85 + 13170 微美元。
    expect(usage).toMatchObject({
      task_id: 'task-1',
      model: MODEL,
      images: 1,
      output_tokens: 439,
      cost_micro_usd: 13_255,
      estimated: false,
    })
  })

  it('sends non-members to sub2api with the ratio written into the prompt', async () => {
    const result = await call({ size: '1280x720' }, false)
    expect(sent.map((one) => one.route)).toEqual(['sub2api'])
    expect(sent[0]!.body.prompt).toBe(
      'a cat\n\nComposition: a wide 16:9 landscape frame, horizontal orientation.',
    )
    expect(routeOf(result.payload)).toEqual({ route: 'sub2api', degraded: false })
    expect(await db.select().from(schema.gpt_direct_usage)).toHaveLength(0)
  })

  it('moves a member to sub2api at once when direct is cooling down, and marks premium output degraded', async () => {
    await coolDownSchedulerBuckets([`openai:direct:model:${MODEL}`], 3_600_000)
    const result = await call({ size: '2048x2048', quality: 'high' }, true)
    expect(sent.map((one) => one.route)).toEqual(['sub2api'])
    expect(routeOf(result.payload)).toEqual({ route: 'sub2api', degraded: true })
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

describe('failover', () => {
  it('retries a member on sub2api once when direct answers 5xx, without recording direct cost', async () => {
    behaviour.direct.status = 503
    const result = await call({}, true)
    expect(sent.map((one) => one.route)).toEqual(['direct', 'sub2api'])
    expect(routeOf(result.payload)).toEqual({ route: 'sub2api', degraded: false })
    expect(await db.select().from(schema.gpt_direct_usage)).toHaveLength(0)
  })

  it('switches to sub2api when direct runs past the attempt timeout, and charges the platform an estimate', async () => {
    behaviour.direct.latencyMs = 5_000
    const result = await call({}, true)
    expect(sent.map((one) => one.route)).toEqual(['direct', 'sub2api'])
    expect(routeOf(result.payload)).toEqual({ route: 'sub2api', degraded: false })
    const [usage] = await db.select().from(schema.gpt_direct_usage)
    expect(usage).toMatchObject({ estimated: true, output_tokens: null })
  })

  it('lets a non-member borrow direct when sub2api runs past the attempt timeout', async () => {
    behaviour.sub2api.latencyMs = 5_000
    const result = await call({}, false)
    expect(sent.map((one) => one.route)).toEqual(['sub2api', 'direct'])
    expect(routeOf(result.payload)).toEqual({ route: 'direct', degraded: false })
  })

  it('does not move a non-member off a failing sub2api, but opens the breaker so the next order borrows direct', async () => {
    behaviour.sub2api.status = 502
    await expect(call({}, false)).rejects.toBeDefined()
    await expect(call({}, false)).rejects.toBeDefined()
    expect(sent.map((one) => one.route)).toEqual(['sub2api', 'sub2api'])
    expect(sub2apiBreakerOpen()).toBe(true)

    sent = []
    const result = await call({}, false)
    expect(sent.map((one) => one.route)).toEqual(['direct'])
    expect(routeOf(result.payload)).toEqual({ route: 'direct', degraded: false })
  })

  it('does not switch on a client error', async () => {
    behaviour.direct.status = 400
    await expect(call({}, true)).rejects.toBeDefined()
    expect(sent.map((one) => one.route)).toEqual(['direct'])
  })
})

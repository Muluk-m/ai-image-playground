import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

// 两把直连密钥。fetch 换成本地桩，按 Authorization 区分，不打真实上游，也不把密钥写进断言以外的输出。
const PRIMARY = 'test-key-primary-aaaa'
const SECONDARY = 'test-key-secondary-bbbb'
process.env.DATABASE_URL = await resetTestDatabase('bff_gpt_direct_keys')
process.env.UPSTREAM_BASE_URL = 'https://sub2api.example.com'
process.env.UPSTREAM_API_KEY = 'sub2api-key'
process.env.GPT_DIRECT_ENABLED = 'true'
process.env.OPENAI_API_KEY = ''
process.env.OPENAI_API_KEYS = `${PRIMARY},${SECONDARY}`
process.env.OPENAI_API_KEY_BUDGETS_USD = '1,5'
process.env.GPT_DIRECT_MONTHLY_BUDGET_USD = '200'
process.env.GPT_DIRECT_ATTEMPT_TIMEOUT_MS = '300'
process.env.GPT_SUB2API_ATTEMPT_TIMEOUT_MS = '300'
process.env.GPT_SUB2API_BREAKER_FAILURES = '5'
process.env.SCHEDULER_NAMESPACE = 'gpt-keys'
process.env.GPT_DIRECT_CONCURRENCY = '4'
process.env.PORT = '0'
delete process.env.OPENAI_ADMIN_KEY

const { callUpstream, setUpstreamFetchForTesting } = await import('../../lib/upstream')
const { budgetMonthStart } = await import('../../lib/upstream/gpt-budget')
const { _resetDirectBudgetCacheForTesting } = await import('../../lib/upstream/gpt-budget')
const { _setDirectKeyAlertForTesting, directKeyPanel, restoreDirectKey } = await import(
  '../../lib/upstream/gpt-keys'
)
const { fingerprintOf, parseDirectKeyList } = await import('../../lib/upstream/gpt-key-config')
const { _resetSub2apiBreakerForTesting } = await import('../../lib/upstream/gpt-routing')
const { _setOfficialCostsFetchForTesting } = await import('../../lib/upstream/gpt-official-costs')
const { schedulerBucketUsage } = await import('../../lib/upstream/scheduler')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { db, schema } = await import('../../db/client')
const { registerAppAlertScan } = await import('../../ops/alert-kick')

const MODEL = 'gpt-image-2.5-flare'
const primaryId = fingerprintOf(PRIMARY)
const secondaryId = fingerprintOf(SECONDARY)
type Slot = 'primary' | 'secondary' | 'sub2api'

interface Reply {
  status: number
  body?: unknown
}

let sent: Slot[] = []
let replies: Record<Slot, Reply>
let alerts: Array<{ fingerprint: string; label: string; reason: string }> = []
let kicks = 0

function stub(): void {
  setUpstreamFetchForTesting((async (
    input: unknown,
    init?: { headers?: Record<string, string> },
  ) => {
    const url = new URL(String(input))
    const authorization = init?.headers?.authorization ?? ''
    const slot: Slot =
      url.hostname !== 'api.openai.com'
        ? 'sub2api'
        : authorization.endsWith('bbbb')
          ? 'secondary'
          : 'primary'
    sent.push(slot)
    const reply = replies[slot]
    return new Response(
      JSON.stringify(
        reply.body ??
          (reply.status === 200
            ? {
                data: [{ b64_json: 'ok' }],
                ...(slot === 'sub2api'
                  ? {}
                  : {
                      usage: {
                        input_tokens: 17,
                        input_tokens_details: { image_tokens: 0, text_tokens: 17 },
                        output_tokens: 439,
                      },
                    }),
              }
            : { error: { message: `upstream ${reply.status}`, type: 'server_error' } }),
      ),
      { status: reply.status, headers: { 'content-type': 'application/json' } },
    )
  }) as never)
}

const call = () =>
  callUpstream({
    provider: 'openai-compat',
    model: MODEL,
    taskId: 'task-keys',
    gptMember: true,
    request: { prompt: 'a cat' },
    onGptRoute: async (route) => {
      routes.push(route)
    },
  })

let routes: string[] = []

beforeEach(async () => {
  _setChannelsForTesting([])
  _resetSub2apiBreakerForTesting()
  _resetDirectBudgetCacheForTesting()
  _setOfficialCostsFetchForTesting()
  alerts = []
  kicks = 0
  _setDirectKeyAlertForTesting((event) => {
    alerts.push(event)
  })
  registerAppAlertScan(async () => {
    kicks += 1
  })
  sent = []
  routes = []
  replies = {
    primary: { status: 200 },
    secondary: { status: 200 },
    sub2api: { status: 200 },
  }
  stub()
  await db.delete(schema.scheduler_leases)
  await db.delete(schema.scheduler_buckets)
  await db.delete(schema.gpt_direct_usage)
  await db.delete(schema.gpt_direct_key_state)
})

afterEach(() => {
  setUpstreamFetchForTesting()
  _setDirectKeyAlertForTesting()
  registerAppAlertScan()
  delete process.env.OPENAI_ADMIN_KEY
})

describe('config', () => {
  it('rejects a budget list that does not match, without echoing the key', () => {
    const secret = 'sk-live-secret-should-not-leak'
    expect(() => parseDirectKeyList(`${secret},other-key-xxxx`, '1')).toThrow(
      /OPENAI_API_KEY_BUDGETS_USD/,
    )
    try {
      parseDirectKeyList(`${secret},other-key-xxxx`, '1')
    } catch (error) {
      expect(String(error)).not.toContain(secret)
    }
    expect(primaryId.fingerprint).not.toBe(secondaryId.fingerprint)
    expect(primaryId.label).not.toContain(PRIMARY)
    expect(primaryId.label.endsWith('aaaa')).toBe(true)
  })
})

describe('key failover', () => {
  it('uses the first key and records the cost against its fingerprint', async () => {
    await call()
    expect(sent).toEqual(['primary'])
    expect(routes).toEqual(['direct'])
    const [usage] = await db.select().from(schema.gpt_direct_usage)
    expect(usage?.key_fingerprint).toBe(primaryId.fingerprint)
    expect(JSON.stringify(usage)).not.toContain(PRIMARY)
  })

  it('disables an invalid key, alerts, and retries the next key inside the same direct route', async () => {
    replies.primary = {
      status: 401,
      body: { error: { message: 'Incorrect API key', code: 'invalid_api_key' } },
    }
    await call()
    expect(sent).toEqual(['primary', 'secondary'])
    expect(routes).toEqual(['direct'])
    expect(alerts).toEqual([
      { fingerprint: primaryId.fingerprint, label: primaryId.label, reason: 'invalid' },
    ])
    expect(kicks).toBe(1)
    expect(JSON.stringify(alerts)).not.toContain(PRIMARY)
    const [state] = await db.select().from(schema.gpt_direct_key_state)
    expect(state).toMatchObject({
      fingerprint: primaryId.fingerprint,
      disabled_reason: 'invalid',
    })
    expect(state?.last_error ?? '').not.toContain(PRIMARY)
    const [usage] = await db.select().from(schema.gpt_direct_usage)
    expect(usage?.key_fingerprint).toBe(secondaryId.fingerprint)
  })

  it('treats insufficient quota as a disable, not a short cooldown', async () => {
    replies.primary = {
      status: 429,
      body: {
        error: {
          message: 'You exceeded your current quota, please check your plan and billing details.',
          type: 'insufficient_quota',
          code: 'insufficient_quota',
        },
      },
    }
    await call()
    expect(sent).toEqual(['primary', 'secondary'])
    expect(routes).toEqual(['direct'])
    const [state] = await db.select().from(schema.gpt_direct_key_state)
    expect(state?.disabled_reason).toBe('quota')
    expect(state?.cooldown_until ?? null).toBeNull()
    expect(alerts[0]?.reason).toBe('quota')
  })

  it('cools a rate-limited key without blocking the next key on the shared bucket', async () => {
    replies.primary = {
      status: 429,
      body: { error: { message: 'Rate limit reached', type: 'rate_limit_exceeded' } },
    }
    await call()
    expect(sent).toEqual(['primary', 'secondary'])
    expect(routes).toEqual(['direct'])
    expect(alerts).toEqual([])
    const [state] = await db.select().from(schema.gpt_direct_key_state)
    expect(state?.fingerprint).toBe(primaryId.fingerprint)
    expect(state?.disabled_reason ?? null).toBeNull()
    expect(state?.cooldown_until ?? 0).toBeGreaterThan(Date.now())
    expect((await schedulerBucketUsage(`openai:direct:model:${MODEL}`)).cooldownUntil).toBeNull()
    expect(await restoreDirectKey(primaryId.fingerprint)).toBe(true)
    replies.primary = { status: 200 }
    sent = []
    await call()
    expect(sent).toEqual(['primary'])
  })

  it('skips a key that has used its own monthly budget', async () => {
    await db.insert(schema.gpt_direct_usage).values({
      id: 'primary-spent',
      model: MODEL,
      images: 1,
      cost_micro_usd: 1_000_000,
      estimated: false,
      key_fingerprint: primaryId.fingerprint,
      created_at: Date.now(),
    })
    await call()
    expect(sent).toEqual(['secondary'])
    expect(routes).toEqual(['direct'])
    expect(alerts).toEqual([])
    const panel = await directKeyPanel(7)
    expect(panel.keys.find((key) => key.fingerprint === primaryId.fingerprint)?.status).toBe(
      'budget',
    )
    expect(panel.currency_note).toBe('usage')
    expect(panel.official).toBeNull()
    expect(JSON.stringify(panel)).not.toContain(PRIMARY)
    expect(JSON.stringify(panel)).not.toContain(SECONDARY)
  })

  it('falls back to sub2api only after every key is unusable', async () => {
    replies.primary = {
      status: 401,
      body: { error: { message: 'Incorrect API key', code: 'invalid_api_key' } },
    }
    replies.secondary = {
      status: 429,
      body: { error: { message: 'billing hard limit', code: 'billing_hard_limit_reached' } },
    }
    await call()
    expect(sent).toEqual(['primary', 'secondary', 'sub2api'])
    expect(routes).toEqual(['direct', 'sub2api'])
    expect(alerts.map((alert) => alert.fingerprint)).toEqual([
      primaryId.fingerprint,
      secondaryId.fingerprint,
    ])
    expect(await db.select().from(schema.gpt_direct_usage)).toHaveLength(0)
  })

  it('uses a restored key again, and ignores last month when judging the budget', async () => {
    replies.primary = {
      status: 401,
      body: { error: { message: 'Incorrect API key', code: 'invalid_api_key' } },
    }
    await call()
    expect(await restoreDirectKey(primaryId.fingerprint, 'ops')).toBe(true)
    expect(await restoreDirectKey('00000000')).toBe(false)
    replies.primary = { status: 200 }
    sent = []
    routes = []
    await db.insert(schema.gpt_direct_usage).values({
      id: 'last-month',
      model: MODEL,
      images: 1,
      cost_micro_usd: 5_000_000,
      estimated: false,
      key_fingerprint: primaryId.fingerprint,
      created_at: budgetMonthStart(Date.now()) - 1_000,
    })
    _resetDirectBudgetCacheForTesting()
    await call()
    expect(sent).toEqual(['primary'])
    const panel = await directKeyPanel(7)
    expect(panel.keys[0]).toMatchObject({
      fingerprint: primaryId.fingerprint,
      ordinal: 1,
      status: 'available',
    })
    expect(panel.keys[1]?.ordinal).toBe(2)
  })
})

describe('official costs', () => {
  it('shows the Costs API totals only when an admin key is configured', async () => {
    expect((await directKeyPanel(7)).official).toBeNull()
    process.env.OPENAI_ADMIN_KEY = 'sk-admin-test-zzzz'
    let authorization = ''
    _setOfficialCostsFetchForTesting(async (_url, init) => {
      authorization = new Headers(init?.headers).get('authorization') ?? ''
      return new Response(
        JSON.stringify({
          data: [
            {
              start_time: 1_700_000_000,
              results: [{ amount: { value: 1.25, currency: 'usd' } }],
            },
          ],
        }),
        { status: 200 },
      )
    })
    const panel = await directKeyPanel(30)
    expect(panel.days).toBe(30)
    expect(panel.official).toEqual({
      ok: true,
      days: [
        {
          day: new Date(1_700_000_000 * 1000).toISOString().slice(0, 10),
          cost_micro_usd: 1_250_000,
        },
      ],
    })
    expect(authorization).toBe('Bearer sk-admin-test-zzzz')
    expect(JSON.stringify(panel)).not.toContain('sk-admin-test-zzzz')
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { evaluateAlerts, QUEUE_TIMEOUTS } from '@image-playground/shared'
import { eq, sql } from 'drizzle-orm'

// 两把直连密钥。fetch 换成本地桩，按 Authorization 区分，不打真实上游，也不把密钥写进断言以外的输出。
const PRIMARY = 'test-key-primary-aaaa'
const SECONDARY = 'test-key-secondary-bbbb'
process.env.DATABASE_URL = await resetTestDatabase('bff_gpt_direct_keys')
process.env.UPSTREAM_BASE_URL = 'https://sub2api.example.com'
process.env.UPSTREAM_API_KEY = 'sub2api-key'
process.env.GPT_DIRECT_ENABLED = 'true'
process.env.GPT_IMAGE_26_ENABLED = 'true'
process.env.OPENAI_API_KEY = ''
process.env.OPENAI_API_KEYS = `${PRIMARY},${SECONDARY}`
process.env.OPENAI_API_KEY_BUDGETS_USD = '1,5'
process.env.GPT_DIRECT_MONTHLY_BUDGET_USD = '200'
// 密钥切换包含真实数据库操作；超时行为由下面的独立队列用例控制。
process.env.GPT_DIRECT_ATTEMPT_TIMEOUT_MS = '5000'
process.env.GPT_SUB2API_ATTEMPT_TIMEOUT_MS = '5000'
process.env.GPT_SUB2API_BREAKER_FAILURES = '5'
process.env.SCHEDULER_NAMESPACE = 'gpt-keys'
process.env.GPT_DIRECT_CONCURRENCY = '4'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.PORT = '0'
delete process.env.OPENAI_ADMIN_KEY

const { callUpstream, setUpstreamFetchForTesting } = await import('../../lib/upstream')
const { budgetMonthStart } = await import('../../lib/upstream/gpt-budget')
const { _resetDirectBudgetCacheForTesting } = await import('../../lib/upstream/gpt-budget')
const { _setDirectKeyAlertForTesting, directKeyPanel, disabledDirectKeys, restoreDirectKey } =
  await import('../../lib/upstream/gpt-keys')
const { refreshGptDirectKeys } = await import('../../lib/upstream/gpt-direct-admin')
const {
  configuredDirectKeys,
  FingerprintSecretMissingError,
  fingerprintOf,
  noteDirectKeySnapshot,
  parseDirectKeyList,
  resetAdminDirectKeySnapshot,
  safeEnvDirectKeys,
} = await import('../../lib/upstream/gpt-key-config')
const { config } = await import('../../config')
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
  resetAdminDirectKeySnapshot()
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
  await db.delete(schema.gpt_direct_budget_holds)
  await db.delete(schema.gpt_direct_usage)
  await db.delete(schema.gpt_direct_key_state)
  await db.delete(schema.gpt_direct_admin_keys)
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

  it('refuses to fingerprint when no server secret is configured', () => {
    const saved = process.env.INTERNAL_API_TOKEN
    delete process.env.INTERNAL_API_TOKEN
    delete process.env.EMAIL_CODE_SECRET
    delete process.env.UPSTREAM_SECRETS_MASTER_KEY
    try {
      expect(() => fingerprintOf('sk-should-not-be-hashed-with-an-empty-key')).toThrow(
        FingerprintSecretMissingError,
      )
      expect(safeEnvDirectKeys()).toEqual([])
    } finally {
      process.env.INTERNAL_API_TOKEN = saved
    }
  })

  it('keeps the panel open and the alert scan blind when the env key list cannot be parsed', async () => {
    const saved = {
      token: process.env.INTERNAL_API_TOKEN,
      email: process.env.EMAIL_CODE_SECRET,
      master: process.env.UPSTREAM_SECRETS_MASTER_KEY,
    }
    delete process.env.INTERNAL_API_TOKEN
    delete process.env.EMAIL_CODE_SECRET
    delete process.env.UPSTREAM_SECRETS_MASTER_KEY
    try {
      const panel = await directKeyPanel(7)
      expect(panel.keys).toEqual([])
      expect(panel.writable).toBe(false)
      expect(panel.disabled_reason).toContain('指纹密钥')
      // 抛错＝「没观察到」；返回空数组会被当成所有停用的密钥都已恢复。
      await expect(disabledDirectKeys()).rejects.toBeInstanceOf(FingerprintSecretMissingError)
    } finally {
      process.env.INTERNAL_API_TOKEN = saved.token
      if (saved.email !== undefined) process.env.EMAIL_CODE_SECRET = saved.email
      if (saved.master !== undefined) process.env.UPSTREAM_SECRETS_MASTER_KEY = saved.master
    }
  })

  it('uses admin keys when any are stored, and otherwise keeps the env list', () => {
    const adminSecret = 'admin-key-cccc'
    const admin = fingerprintOf(adminSecret)
    noteDirectKeySnapshot({
      admin: [
        {
          id: 'row-1',
          ordinal: 1,
          secret: adminSecret,
          budgetUsd: 50,
          enabled: true,
          ...admin,
        },
      ],
      hardDisabled: new Set(),
    })
    expect(configuredDirectKeys().map((key) => key.fingerprint)).toEqual([admin.fingerprint])
    resetAdminDirectKeySnapshot()
    expect(configuredDirectKeys()[0]?.fingerprint).toBe(primaryId.fingerprint)
    expect(JSON.stringify(configuredDirectKeys().map((key) => key.label))).not.toContain(
      adminSecret,
    )
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

  it.each([
    undefined,
    'ab'.repeat(32),
  ])('keeps disabled env keys out of routing after refresh with master %s, then restores a key', async (master) => {
    const savedMaster = process.env.UPSTREAM_SECRETS_MASTER_KEY
    if (master === undefined) delete process.env.UPSTREAM_SECRETS_MASTER_KEY
    else process.env.UPSTREAM_SECRETS_MASTER_KEY = master
    try {
      await db.insert(schema.gpt_direct_key_state).values(
        [primaryId, secondaryId].map((key) => ({
          fingerprint: key.fingerprint,
          disabled_reason: 'quota' as const,
          updated_at: Date.now(),
        })),
      )
      await refreshGptDirectKeys()
      await db.execute(
        sql`ALTER TABLE gpt_direct_key_state RENAME TO unavailable_env_key_state_fixture`,
      )
      try {
        await call()
        expect(sent).toEqual(['sub2api'])
      } finally {
        await db.execute(
          sql`ALTER TABLE unavailable_env_key_state_fixture RENAME TO gpt_direct_key_state`,
        )
      }
      await restoreDirectKey(primaryId.fingerprint, 'test')
      await refreshGptDirectKeys()
      sent = []
      await call()
      expect(sent).toEqual(['primary'])
    } finally {
      if (savedMaster === undefined) delete process.env.UPSTREAM_SECRETS_MASTER_KEY
      else process.env.UPSTREAM_SECRETS_MASTER_KEY = savedMaster
    }
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

  it('keeps key alerts consistent across stale snapshots and resolves once after manual disable', async () => {
    const configured = configuredDirectKeys()[0]!
    await db.insert(schema.gpt_direct_key_state).values({
      fingerprint: primaryId.fingerprint,
      disabled_reason: 'quota',
      updated_at: Date.now(),
    })
    await db.insert(schema.gpt_direct_admin_keys).values({
      id: 'admin-key',
      ordinal: 1,
      fingerprint: primaryId.fingerprint,
      budget_usd: 1,
      enabled: true,
      nonce: 'test-nonce',
      tag: 'test-tag',
      ciphertext: 'test-ciphertext',
      updated_at: Date.now(),
      updated_by: 'test',
    })
    const now = Date.now()
    const disabled = [
      {
        fingerprint: primaryId.fingerprint,
        label: primaryId.fingerprint,
        reason: 'quota' as const,
      },
    ]
    noteDirectKeySnapshot({ admin: [], hardDisabled: new Set() })
    expect(await disabledDirectKeys()).toEqual(disabled)
    const firing = evaluateAlerts({ gptDirectKeys: { disabled } }, {}, now)
    expect(firing.messages.map((message) => message.kind)).toEqual(['firing'])
    noteDirectKeySnapshot({ admin: [{ ...configured, id: 'admin-key', enabled: false }] })
    const stillDisabled = await disabledDirectKeys()
    expect(stillDisabled).toEqual(disabled)
    expect(
      evaluateAlerts({ gptDirectKeys: { disabled: stillDisabled } }, firing.state, now + 1000)
        .messages,
    ).toEqual([])

    await db
      .update(schema.gpt_direct_admin_keys)
      .set({ enabled: false })
      .where(eq(schema.gpt_direct_admin_keys.id, 'admin-key'))
    noteDirectKeySnapshot({ admin: [{ ...configured, id: 'admin-key', enabled: true }] })
    const suppressed = await disabledDirectKeys()
    expect(suppressed).toEqual([])
    const resolved = evaluateAlerts(
      { gptDirectKeys: { disabled: suppressed } },
      firing.state,
      now + 2000,
    )
    expect(resolved.messages.map((message) => message.kind)).toEqual(['resolved'])
    noteDirectKeySnapshot({ admin: [] })
    expect(
      evaluateAlerts(
        { gptDirectKeys: { disabled: await disabledDirectKeys() } },
        resolved.state,
        now + 3000,
      ).messages,
    ).toEqual([])
    const [state] = await db.select().from(schema.gpt_direct_key_state)
    expect(state?.disabled_reason).toBe('quota')
  })

  it('observes environment keys after the last admin key is removed despite a stale admin snapshot', async () => {
    const configured = configuredDirectKeys()[0]!
    noteDirectKeySnapshot({ admin: [{ ...configured, id: 'removed-key', enabled: false }] })
    await db.insert(schema.gpt_direct_key_state).values({
      fingerprint: secondaryId.fingerprint,
      disabled_reason: 'invalid',
      updated_at: Date.now(),
    })
    expect(await disabledDirectKeys()).toEqual([{ ...secondaryId, reason: 'invalid' }])
  })

  it('does not bill a key that never left the queue after the previous key was rejected', async () => {
    const imagesPerMinute = config.scheduler.gpt.directImagesPerMinute
    const timeouts = QUEUE_TIMEOUTS as { UPSTREAM_HARD_TIMEOUT_MS: number }
    const hardTimeout = timeouts.UPSTREAM_HARD_TIMEOUT_MS
    config.scheduler.gpt.directImagesPerMinute = 1
    timeouts.UPSTREAM_HARD_TIMEOUT_MS = 400
    replies.primary = {
      status: 401,
      body: { error: { message: 'Incorrect API key', code: 'invalid_api_key' } },
    }
    try {
      await expect(call()).rejects.toBeDefined()
      expect(sent).toEqual(['primary'])
      const usage = await db.select().from(schema.gpt_direct_usage)
      expect(usage.some((row) => row.key_fingerprint === secondaryId.fingerprint)).toBe(false)
      expect(usage).toHaveLength(0)
    } finally {
      config.scheduler.gpt.directImagesPerMinute = imagesPerMinute
      timeouts.UPSTREAM_HARD_TIMEOUT_MS = hardTimeout
    }
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

  it('keeps GPT 2.6 disabled when restoring its key rolls back, then reopens after commit', async () => {
    await db.insert(schema.gpt_direct_key_state).values(
      [primaryId, secondaryId].map((key) => ({
        fingerprint: key.fingerprint,
        disabled_reason: 'quota' as const,
        updated_at: Date.now(),
      })),
    )
    await refreshGptDirectKeys()
    await db.execute(sql`ALTER TABLE operator_audits RENAME TO unavailable_restore_audits_fixture`)
    try {
      await expect(restoreDirectKey(primaryId.fingerprint, 'ops')).rejects.toThrow()
    } finally {
      await db.execute(
        sql`ALTER TABLE unavailable_restore_audits_fixture RENAME TO operator_audits`,
      )
    }
    const generate = () =>
      callUpstream({
        provider: 'openai-compat',
        model: 'gpt-image-2.6-flare',
        request: { prompt: 'a cat' },
      })
    await expect(generate()).rejects.toThrow('direct route is not configured')
    expect(sent).toEqual([])
    await restoreDirectKey(primaryId.fingerprint, 'ops')
    await generate()
    expect(sent).toEqual(['primary'])
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

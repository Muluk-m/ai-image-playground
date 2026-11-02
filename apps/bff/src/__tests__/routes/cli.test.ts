import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq, sql } from 'drizzle-orm'
import type { PrivateTaskHooks } from '../../lib/private-overlay'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

const TEST_DB = await resetTestDatabase('bff_cli_routes')

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.CORS_ALLOWED_ORIGINS = 'https://studio.test'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../cli-operator-config.json')
process.env.CLIENT_IP_SOURCE = 'cf-connecting-ip'
process.env.GPT_DIRECT_ENABLED = 'true'
process.env.OPENAI_API_KEY = 'fixture-direct-key'

// 计费能力要求 overlay 在场：替身必须在 app 求值之前装好。
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)

type ReservationLog = { taskId: string; model: string; credits: number; unitMultiplier: number }
const billing = {
  members: new Set<string>(),
  quote: 10,
  reservePrice: undefined as number | undefined,
  reservations: [] as ReservationLog[],
  settlements: [] as { taskId: string; outcome: string }[],
}

_setPrivateBffOverlayForTesting(
  Object.freeze({
    ...EMPTY_PRIVATE_BFF_OVERLAY,
    present: true,
    taskHooks: {
      ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks,
      async canSubmitTask({ userId }: { userId: string }) {
        return billing.members.has(userId)
      },
      async isActiveMember({ userId }: { userId: string }) {
        return billing.members.has(userId)
      },
      async quoteTask({
        quantity,
        unitMultiplier,
      }: Parameters<NonNullable<PrivateTaskHooks['quoteTask']>>[0]) {
        return { estimatedCredits: billing.quote * quantity * unitMultiplier, pricing: {} as never }
      },
      async reserveTask({
        tx,
        taskId,
        model,
        quantity,
        unitMultiplier,
      }: Parameters<PrivateTaskHooks['reserveTask']>[0]) {
        const credits = (billing.reservePrice ?? billing.quote) * quantity * unitMultiplier
        billing.reservations.push({ taskId, model, credits, unitMultiplier })
        await tx.execute(
          sql`INSERT INTO cli_test_holds (task_id, credits) VALUES (${taskId}, ${credits})`,
        )
        return { kind: 'reserved' as const, credits }
      },
      async finalizeTask({ taskId, outcome }: { taskId: string; outcome: string }) {
        billing.settlements.push({ taskId, outcome })
      },
      async accountSummary({ userId }: { userId: string }) {
        return { credits: 500, isMember: billing.members.has(userId) }
      },
    },
  }),
)

const { config } = await import('../../config')
const { app } = await import('../../app')
const { close: closeDb, db, schema } = await import('../../db/client')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')
const { _setChannelsForTesting, parseChannelsConfig } = await import('../../lib/channels')
const { _resetInactiveModelsForTesting } = await import('../../lib/model-availability')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { hashCliSecret } = await import('../../lib/cli/auth')
// These modules must load after the test database, environment and billing overlay are installed.
const { runTask } = await import('../../workers/task-runner')
const { setUpstreamFetchForTesting } = await import('../../lib/upstream')
const { _resetDirectBudgetCacheForTesting } = await import('../../lib/upstream/gpt-budget')

const CHANNELS = parseChannelsConfig(
  {
    channels: [
      {
        id: 'gemini-direct',
        kind: 'gemini-queue',
        label: 'Gemini',
        baseUrl: 'https://gemini.example.com/v1',
        auth: { type: 'bearer', secretRef: 'GEMINI_TEST_KEY' },
        defaults: { apiMode: 'images', timeout: 600 },
        allowedPaths: ['models/gemini-3-pro-image:generateContent'],
        models: [
          {
            id: 'gemini-3-pro-image',
            label: 'Nano Banana Pro',
            capabilities: ['generate', 'edit', 'size'],
          },
        ],
      },
      {
        id: 'openai-images',
        kind: 'openai-queue',
        label: 'GPT',
        baseUrl: 'https://openai.example.com/v1',
        auth: { type: 'bearer', secretRef: 'GEMINI_TEST_KEY' },
        defaults: { apiMode: 'images', timeout: 600 },
        allowedPaths: ['images/generations', 'images/edits'],
        models: [
          {
            id: 'gpt-image-2.5-flare',
            label: 'GPT Image 2.5 Flare',
            capabilities: ['generate', 'edit', 'size', 'quality'],
          },
        ],
      },
    ],
  },
  (key) => (key === 'GEMINI_TEST_KEY' ? 'fixture-key' : undefined),
).channels

// Test-owned ledger: transaction rollback must undo holds, not merely delete the task row.
await db.execute(
  sql`CREATE TABLE cli_test_holds (task_id text PRIMARY KEY, credits integer NOT NULL)`,
)

beforeEach(async () => {
  setObjectStoreForTesting(new InMemoryObjectStore())
  setDurableMediaStoreForTesting(
    Object.assign(new InMemoryObjectStore(), {
      sign: (key: string) => `https://media.test/${key}`,
    }) as never,
  )
  _setChannelsForTesting(CHANNELS)
  _resetInactiveModelsForTesting()
  billing.members.clear()
  billing.quote = 10
  billing.reservePrice = undefined
  Object.assign(config.gptDirect, { enabled: true })
  _resetDirectBudgetCacheForTesting()
  billing.reservations.length = 0
  billing.settlements.length = 0
  await db.execute(sql`TRUNCATE cli_test_holds`)
  await db.delete(schema.scheduler_leases)
  await db.delete(schema.scheduler_buckets)
  await db.delete(schema.gpt_direct_usage)
  await db.execute(
    sql`TRUNCATE cli_jobs, cli_reference_media, cli_retired_refresh_tokens, cli_connections, device_authorizations, generation_images, generation_records, generation_commands, tasks, media_objects, user_sessions, operator_audits, users CASCADE`,
  )
})

afterEach(() => {
  setObjectStoreForTesting()
  setDurableMediaStoreForTesting()
  _setChannelsForTesting([])
  setUpstreamFetchForTesting()
})

afterAll(async () => {
  await closeDb()
})

async function call(
  method: string,
  path: string,
  options: { body?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {},
) {
  // 每次换一个来源 IP：令牌端点按 IP 限流，整个文件共用一个进程内限流器。
  const ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`
  const headers: Record<string, string> = {
    'cf-connecting-ip': ip,
    origin: 'https://studio.test',
    ...options.headers,
  }
  let body: string | undefined
  if (options.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(options.form).toString()
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  const res = await app.handle(new Request(`http://localhost${path}`, { method, headers, body }))
  const text = await res.text()
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null }
}

async function createUser(id: string) {
  const now = Date.now()
  await db.insert(schema.users).values({
    id,
    username: id,
    password_hash: 'x',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  const session = await db.transaction((tx) => createUserSession(id, tx))
  return { id, cookie: `${USER_SESSION_COOKIE}=${session}` }
}

async function startDevice() {
  const res = await call('POST', '/v1/oauth/device_authorization', {
    form: { client_id: 'muvloom-cli' },
  })
  expect(res.status).toBe(200)
  return res.json as { device_code: string; user_code: string; verification_uri_complete: string }
}

function pollToken(deviceCode: string) {
  return call('POST', '/v1/oauth/token', {
    form: {
      client_id: 'muvloom-cli',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
    },
  })
}

/** 跑完一遍设备授权，返回这次签发的令牌。 */
async function connect(user: { cookie: string }) {
  const device = await startDevice()
  const decision = await call('POST', '/api/cli/device', {
    body: { user_code: device.user_code.toLowerCase(), decision: 'approve' },
    headers: { cookie: user.cookie },
  })
  expect(decision.status).toBe(200)
  const token = await pollToken(device.device_code)
  expect(token.status).toBe(200)
  return token.json as { access_token: string; refresh_token: string }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

function imageJob(overrides: Record<string, unknown> = {}) {
  return {
    prompt: 'a red fox in snow',
    idempotency_key: `key-${crypto.randomUUID()}`,
    ...overrides,
  }
}

describe('CLI API capability gate', () => {
  it('keeps every CLI entry closed while the capability is off, without touching other routes', async () => {
    Object.assign(config.operator.capabilities, { 'cli:api': false })
    try {
      const me = await call('GET', '/v1/me', { headers: bearer('anything') })
      expect(me.status).toBe(404)
      expect(me.json).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE' } })
      const device = await call('POST', '/v1/oauth/device_authorization', {
        form: { client_id: 'muvloom-cli' },
      })
      expect(device.status).toBe(404)
      const channels = await call('GET', '/api/channels')
      expect(channels.status).toBe(200)
    } finally {
      Object.assign(config.operator.capabilities, { 'cli:api': true })
    }
  })

  it('leaves website routes untouched while the capability is on', async () => {
    const channels = await call('GET', '/api/channels')
    expect(channels.status).toBe(200)
    const unauthenticated = await call('GET', '/v1/me')
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.json).toMatchObject({
      schema_version: 1,
      ok: false,
      error: { code: 'UNAUTHENTICATED' },
    })
  })
})

describe('device authorization', () => {
  it('walks pending, slow_down, approval and single-use exchange, storing only hashes', async () => {
    const user = await createUser('device-owner')
    const device = await startDevice()
    expect(device.verification_uri_complete).toStartWith('https://studio.test/device?user_code=')

    expect((await pollToken(device.device_code)).json).toEqual({ error: 'authorization_pending' })
    expect((await pollToken(device.device_code)).json).toEqual({ error: 'slow_down' })

    const page = await call(
      'GET',
      `/api/cli/device?user_code=${encodeURIComponent(device.user_code)}`,
      { headers: { cookie: user.cookie } },
    )
    expect(page.json).toMatchObject({ client_name: 'Muvloom CLI' })
    expect(page.json.scopes).toContain('images:write')

    await db.update(schema.device_authorizations).set({ last_polled_at: Date.now() - 60_000 })
    await call('POST', '/api/cli/device', {
      body: { user_code: device.user_code, decision: 'approve' },
      headers: { cookie: user.cookie },
    })
    const issued = await pollToken(device.device_code)
    expect(issued.status).toBe(200)
    expect(issued.json).toMatchObject({ token_type: 'Bearer', expires_in: 7200 })
    expect((await pollToken(device.device_code)).json).toEqual({ error: 'invalid_grant' })

    const stored = JSON.stringify(await db.select().from(schema.cli_connections))
    expect(stored).not.toContain(issued.json.access_token)
    expect(stored).not.toContain(issued.json.refresh_token)
    const audits = await db.select().from(schema.operator_audits)
    expect(JSON.stringify(audits)).not.toContain(issued.json.access_token)
    expect(audits.map((row) => row.action)).toContain('cli.token.issued')
  })

  it('reports a denial and requires a website session to decide', async () => {
    const user = await createUser('device-denier')
    const device = await startDevice()
    const anonymous = await call('POST', '/api/cli/device', {
      body: { user_code: device.user_code, decision: 'approve' },
    })
    expect(anonymous.status).toBe(401)
    const crossSite = await call('POST', '/api/cli/device', {
      body: { user_code: device.user_code, decision: 'approve' },
      headers: { cookie: user.cookie, origin: 'https://evil.example' },
    })
    expect(crossSite.status).toBe(403)
    await call('POST', '/api/cli/device', {
      body: { user_code: device.user_code, decision: 'deny' },
      headers: { cookie: user.cookie },
    })
    expect((await pollToken(device.device_code)).json).toEqual({ error: 'access_denied' })
  })

  it('expires codes after their lifetime', async () => {
    const device = await startDevice()
    await db.update(schema.device_authorizations).set({ expires_at: Date.now() - 1 })
    expect((await pollToken(device.device_code)).json).toEqual({ error: 'expired_token' })
  })
})

describe('CLI tokens', () => {
  it('rotates on refresh and revokes the connection when an old refresh token is replayed', async () => {
    const user = await createUser('token-owner')
    const first = await connect(user)
    expect((await call('GET', '/v1/me', { headers: bearer(first.access_token) })).status).toBe(200)

    const refresh = (value: string) =>
      call('POST', '/v1/oauth/token', {
        form: { client_id: 'muvloom-cli', grant_type: 'refresh_token', refresh_token: value },
      })
    const second = await refresh(first.refresh_token)
    expect(second.status).toBe(200)
    expect((await call('GET', '/v1/me', { headers: bearer(first.access_token) })).status).toBe(401)
    expect(
      (await call('GET', '/v1/me', { headers: bearer(second.json.access_token) })).status,
    ).toBe(200)

    expect((await refresh(first.refresh_token)).json).toEqual({ error: 'invalid_grant' })
    expect(
      (await call('GET', '/v1/me', { headers: bearer(second.json.access_token) })).status,
    ).toBe(401)
    expect((await refresh(second.json.refresh_token)).json).toEqual({ error: 'invalid_grant' })
  })

  it('rejects the next request after logout or account-side revocation', async () => {
    const user = await createUser('revoker')
    const viaLogout = await connect(user)
    await call('POST', '/v1/oauth/revoke', {
      form: { client_id: 'muvloom-cli', token: viaLogout.refresh_token },
    })
    expect((await call('GET', '/v1/me', { headers: bearer(viaLogout.access_token) })).status).toBe(
      401,
    )

    const viaSettings = await connect(user)
    const listed = await call('GET', '/api/me/cli-connections', {
      headers: { cookie: user.cookie },
    })
    expect(listed.json.connections).toHaveLength(1)
    const removed = await call(
      'DELETE',
      `/api/me/cli-connections/${listed.json.connections[0].id}`,
      {
        headers: { cookie: user.cookie },
      },
    )
    expect(removed.status).toBe(200)
    expect(
      (await call('GET', '/v1/me', { headers: bearer(viaSettings.access_token) })).status,
    ).toBe(401)
  })

  it('enforces the scopes stored on the connection', async () => {
    const user = await createUser('read-only')
    const tokens = await connect(user)
    await db
      .update(schema.cli_connections)
      .set({ scopes: 'images:read' })
      .where(eq(schema.cli_connections.access_token_hash, hashCliSecret(tokens.access_token)))
    const create = await call('POST', '/v1/image-jobs', {
      body: imageJob(),
      headers: bearer(tokens.access_token),
    })
    expect(create.status).toBe(403)
    expect(create.json.error.code).toBe('FORBIDDEN')
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
  })
})

describe('capabilities and dry-run', () => {
  it('lists account-specific models and hides 4K from non-members', async () => {
    const user = await createUser('caps-user')
    const { access_token } = await connect(user)
    const caps = await call('GET', '/v1/capabilities', { headers: bearer(access_token) })
    expect(caps.json.data.default_model).toBe('gemini-3-pro-image')
    expect(caps.json.data.models[0].image_sizes).toEqual(['1K', '2K'])
    expect(caps.json.data.models[0].price).toEqual({ estimated_credits: 10 })

    billing.members.add(user.id)
    const member = await call('GET', '/v1/capabilities', { headers: bearer(access_token) })
    expect(member.json.data.models[0].image_sizes).toEqual(['1K', '2K', '4K'])
  })

  it('quotes without creating a task or holding credits, and agrees with submit on the hash', async () => {
    const user = await createUser('dry-run')
    const { access_token } = await connect(user)
    const body = imageJob({ aspect_ratio: '16:9' })
    const preview = await call('POST', '/v1/image-jobs/validate', {
      body,
      headers: bearer(access_token),
    })
    expect(preview.status).toBe(200)
    expect(preview.json.data).toMatchObject({
      normalized: { model: 'gemini-3-pro-image', aspect_ratio: '16:9', image_size: '1K', count: 1 },
      quote: { estimated_credits: 10 },
      creates_job: false,
    })
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
    expect(billing.reservations).toHaveLength(0)

    const created = await call('POST', '/v1/image-jobs', { body, headers: bearer(access_token) })
    expect(created.json.data.request_hash).toBe(preview.json.data.request_hash)
  })

  it('rejects 4K for non-members and an exceeded max_credits before any task or hold', async () => {
    const user = await createUser('gated')
    const { access_token } = await connect(user)
    for (const path of ['/v1/image-jobs/validate', '/v1/image-jobs']) {
      const premium = await call('POST', path, {
        body: imageJob({ image_size: '4K' }),
        headers: bearer(access_token),
      })
      expect(premium.status).toBe(403)
      expect(premium.json.error.code).toBe('PLAN_REQUIRED')
      const capped = await call('POST', path, {
        body: imageJob({ max_credits: 5 }),
        headers: bearer(access_token),
      })
      expect(capped.status).toBe(402)
      expect(capped.json.error).toMatchObject({
        code: 'MAX_CREDITS_EXCEEDED',
        details: { required: 10, max_credits: 5 },
      })
    }
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
    expect(billing.reservations).toHaveLength(0)
  })

  it('accepts 4K for an active member', async () => {
    const user = await createUser('member')
    billing.members.add(user.id)
    const { access_token } = await connect(user)
    const created = await call('POST', '/v1/image-jobs', {
      body: imageJob({ image_size: '4K' }),
      headers: bearer(access_token),
    })
    expect(created.status).toBe(200)
    const [task] = await db.select().from(schema.tasks)
    expect(task?.request_payload.image_size).toBe('4K')
  })

  it('rejects more than one image and requires an idempotency key on submit', async () => {
    const user = await createUser('strict')
    const { access_token } = await connect(user)
    const many = await call('POST', '/v1/image-jobs', {
      body: imageJob({ count: 2 }),
      headers: bearer(access_token),
    })
    expect(many.status).toBe(400)
    const { idempotency_key: _drop, ...keyless } = imageJob()
    const unkeyed = await call('POST', '/v1/image-jobs', {
      body: keyless,
      headers: bearer(access_token),
    })
    expect(unkeyed.status).toBe(400)
    expect(unkeyed.json.error.code).toBe('INVALID_REQUEST')
  })
})

describe('CLI GPT image pricing', () => {
  it.each([
    { image_size: '2K' },
    { image_size: '4K' },
    { quality: 'high' },
  ])('rejects non-member premium parameters %j without a task or hold', async (parameters) => {
    const user = await createUser('gpt-nonmember')
    const { access_token } = await connect(user)
    for (const path of ['/v1/image-jobs/validate', '/v1/image-jobs']) {
      const denied = await call('POST', path, {
        body: imageJob({ model: 'gpt-image-2.5-flare', ...parameters }),
        headers: bearer(access_token),
      })
      expect(denied.status).toBe(403)
      expect(denied.json.error.code).toBe('PLAN_REQUIRED')
    }
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
    expect(await db.select().from(schema.generation_commands)).toHaveLength(0)
    expect(billing.reservations).toHaveLength(0)
    expect(await db.execute(sql`SELECT * FROM cli_test_holds`)).toHaveLength(0)
  })

  it.each([
    {
      image_size: '2K', aspect_ratio: 'auto', quality: 'medium',
      size: '2048x2048', ratio: '1:1', credits: 20, multiplier: 2,
    },
    {
      image_size: '4K', aspect_ratio: 'auto', quality: 'medium',
      size: '2880x2880', ratio: '1:1', credits: 20, multiplier: 2,
    },
    {
      image_size: '4K', aspect_ratio: '16:9', quality: 'high',
      size: '3840x2160', ratio: '16:9', credits: 80, multiplier: 8,
    },
    {
      image_size: '1K', aspect_ratio: '1:1', quality: 'high',
      size: '1024x1024', ratio: '1:1', credits: 40, multiplier: 4,
    },
    {
      image_size: '2K', aspect_ratio: '1:1', quality: 'low',
      size: '2048x2048', ratio: '1:1', credits: 10, multiplier: 1,
    },
  ])('quotes and holds the canonical member parameters %j', async ({ image_size, aspect_ratio, quality, size, ratio, credits, multiplier }) => {
    const user = await createUser('gpt-member')
    billing.members.add(user.id)
    const { access_token } = await connect(user)
    const body = imageJob({
      model: 'gpt-image-2.5-flare', image_size, aspect_ratio, quality, max_credits: credits,
    })
    const preview = await call('POST', '/v1/image-jobs/validate', { body, headers: bearer(access_token) })
    expect(preview.status).toBe(200)
    expect(preview.json.data).toMatchObject({
      normalized: { image_size, aspect_ratio: ratio, quality },
      quote: { estimated_credits: credits },
      creates_job: false,
    })
    expect(preview.json.data.adjustments).toEqual(
      aspect_ratio === 'auto' ? [{ field: 'ratio', from: 'auto', to: '1:1' }] : [],
    )
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
    expect(await db.execute(sql`SELECT * FROM cli_test_holds`)).toHaveLength(0)
    const created = await call('POST', '/v1/image-jobs', { body, headers: bearer(access_token) })
    expect(created.status).toBe(200)
    expect(created.json.data.request_hash).toBe(preview.json.data.request_hash)
    expect(created.json.data.adjustments).toEqual(preview.json.data.adjustments)
    const [task] = await db.select().from(schema.tasks)
    expect(task?.request_payload).toMatchObject({ size, quality, strict_image_request: true })
    expect(task?.request_payload.n).toBe(1)
    expect(task?.request_payload.image_size).toBeUndefined()
    expect(billing.reservations).toEqual([
      { taskId: task!.id, model: 'gpt-image-2.5-flare', credits, unitMultiplier: multiplier },
    ])
    expect(await db.execute(sql`SELECT credits FROM cli_test_holds`)).toEqual([{ credits }])
  })

  it.each(['disabled', '503'] as const)('keeps premium CLI intent through worker execution when direct is %s', async (failure) => {
    const user = await createUser(`gpt-executor-${failure}`)
    billing.members.add(user.id)
    const { access_token } = await connect(user)
    const created = await call('POST', '/v1/image-jobs', {
      body: imageJob({ model: 'gpt-image-2.5-flare', image_size: '2K' }),
      headers: bearer(access_token),
    })
    expect(created.status).toBe(200)
    const jobId = created.json.data.job.job_id as string
    const requests: string[] = []
    setUpstreamFetchForTesting(async (url) => {
      requests.push(String(url))
      return new Response(JSON.stringify({ error: { message: 'unavailable' } }), { status: 503 })
    })
    if (failure === 'disabled') Object.assign(config.gptDirect, { enabled: false })

    await runTask(jobId)

    const job = await call('GET', `/v1/jobs/${jobId}`, { headers: bearer(access_token) })
    expect(job.json.data).toMatchObject({
      status: 'failed', terminal: true, error: { code: 'PLAN_REQUIRED' },
    })
    expect(billing.settlements).toEqual([{ taskId: jobId, outcome: 'failed' }])
    expect(requests).toHaveLength(failure === 'disabled' ? 0 : 1)
    expect(requests.every((url) => new URL(url).hostname === 'api.openai.com')).toBe(true)
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, jobId))
    expect(task).toMatchObject({ error_type: 'plan_required', next_retry_at: null })
  })

  it('rejects a zero budget and leaves the denied idempotency key reusable', async () => {
    const user = await createUser('gpt-zero-budget')
    billing.members.add(user.id)
    const { access_token } = await connect(user)
    const body = imageJob({ model: 'gpt-image-2.5-flare', image_size: '2K', max_credits: 0 })
    for (const path of ['/v1/image-jobs/validate', '/v1/image-jobs']) {
      const denied = await call('POST', path, { body, headers: bearer(access_token) })
      expect(denied.status).toBe(402)
      expect(denied.json.error).toMatchObject({
        code: 'MAX_CREDITS_EXCEEDED', details: { required: 20, max_credits: 0 },
      })
    }
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
    expect(await db.select().from(schema.generation_commands)).toHaveLength(0)
    expect(billing.reservations).toHaveLength(0)
    expect(await db.execute(sql`SELECT * FROM cli_test_holds`)).toHaveLength(0)
    const allowed = await call('POST', '/v1/image-jobs', {
      body: { ...body, max_credits: 20 }, headers: bearer(access_token),
    })
    expect(allowed.status).toBe(200)
    expect(await db.select().from(schema.tasks)).toHaveLength(1)
  })

  it.each(['membership', 'direct route'] as const)('rechecks %s between quote and submit without downgrading', async (changed) => {
    const user = await createUser('gpt-entitlement-change')
    billing.members.add(user.id)
    const { access_token } = await connect(user)
    const body = imageJob({ model: 'gpt-image-2.5-flare', image_size: '2K' })
    const preview = await call('POST', '/v1/image-jobs/validate', { body, headers: bearer(access_token) })
    expect(preview.status).toBe(200)
    if (changed === 'membership') billing.members.delete(user.id)
    else Object.assign(config.gptDirect, { enabled: false })
    for (const path of ['/v1/image-jobs/validate', '/v1/image-jobs']) {
      const denied = await call('POST', path, { body, headers: bearer(access_token) })
      expect(denied.status).toBe(403)
      expect(denied.json.error.code).toBe('PLAN_REQUIRED')
    }
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
    expect(await db.select().from(schema.generation_commands)).toHaveLength(0)
    expect(billing.reservations).toHaveLength(0)
    expect(await db.execute(sql`SELECT * FROM cli_test_holds`)).toHaveLength(0)
  })

  it('rechecks the price after a quote and rolls back an actual hold above max_credits', async () => {
    const user = await createUser('gpt-price-change')
    billing.members.add(user.id)
    const { access_token } = await connect(user)
    const body = imageJob({ model: 'gpt-image-2.5-flare', image_size: '2K', max_credits: 20 })
    const preview = await call('POST', '/v1/image-jobs/validate', { body, headers: bearer(access_token) })
    expect(preview.json.data.quote.estimated_credits).toBe(20)
    billing.quote = 15
    const repriced = await call('POST', '/v1/image-jobs', { body, headers: bearer(access_token) })
    expect(repriced.status).toBe(402)
    expect(repriced.json.error).toMatchObject({ code: 'MAX_CREDITS_EXCEEDED', details: { required: 30, max_credits: 20 } })
    expect(billing.reservations).toHaveLength(0)
    billing.quote = 10
    billing.reservePrice = 15
    const reserveChanged = await call('POST', '/v1/image-jobs', { body, headers: bearer(access_token) })
    expect(reserveChanged.status).toBe(402)
    expect(reserveChanged.json.error).toMatchObject({ code: 'MAX_CREDITS_EXCEEDED', details: { required: 30, max_credits: 20 } })
    expect(billing.reservations).toHaveLength(1)
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
    expect(await db.select().from(schema.generation_commands)).toHaveLength(0)
    expect(await db.execute(sql`SELECT * FROM cli_test_holds`)).toHaveLength(0)
    billing.reservePrice = 10
    const created = await call('POST', '/v1/image-jobs', { body, headers: bearer(access_token) })
    expect(created.status).toBe(200)
    expect(await db.execute(sql`SELECT credits FROM cli_test_holds`)).toEqual([{ credits: 20 }])
  })

  it('checks actual reserved credits even when both the quote and budget are zero', async () => {
    const user = await createUser('gpt-zero-quote')
    const { access_token } = await connect(user)
    billing.quote = 0
    billing.reservePrice = 10
    const denied = await call('POST', '/v1/image-jobs', {
      body: imageJob({ model: 'gpt-image-2.5-flare', max_credits: 0 }),
      headers: bearer(access_token),
    })
    expect(denied.status).toBe(402)
    expect(denied.json.error).toMatchObject({ code: 'MAX_CREDITS_EXCEEDED', details: { required: 10, max_credits: 0 } })
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
    expect(await db.select().from(schema.generation_commands)).toHaveLength(0)
    expect(await db.execute(sql`SELECT * FROM cli_test_holds`)).toHaveLength(0)
  })

  it('replays a premium command unchanged after membership and price change', async () => {
    const user = await createUser('gpt-replay')
    billing.members.add(user.id)
    const { access_token } = await connect(user)
    const body = imageJob({ model: 'gpt-image-2.5-flare', image_size: '2K', quality: 'high' })
    const created = await call('POST', '/v1/image-jobs', { body, headers: bearer(access_token) })
    expect(created.status).toBe(200)
    billing.members.delete(user.id)
    billing.quote = 50
    Object.assign(config.gptDirect, { enabled: false })
    const replay = await call('POST', '/v1/image-jobs', {
      body: { ...body, max_credits: 0 }, headers: bearer(access_token),
    })
    expect(replay.status).toBe(200)
    expect(replay.json.data.job.id).toBe(created.json.data.job.id)
    expect(replay.json.data.request_hash).toBe(created.json.data.request_hash)
    expect(await db.select().from(schema.tasks)).toHaveLength(1)
    expect(billing.reservations).toHaveLength(1)
    expect(await db.execute(sql`SELECT credits FROM cli_test_holds`)).toEqual([{ credits: 80 }])
    const mismatch = await call('POST', '/v1/image-jobs', {
      body: { ...body, quality: 'low' }, headers: bearer(access_token),
    })
    expect(mismatch.status).toBe(409)
    expect(mismatch.json.error.code).toBe('IDEMPOTENCY_CONFLICT')
  })

  it('keeps website non-member downgrade behavior', async () => {
    const user = await createUser('gpt-website')
    const created = await call('POST', '/v1/queue/openai-compat/gpt-image-2.5-flare/submit', {
      body: { prompt: 'a fox', size: '3840x2160', quality: 'high', device_id: 'website-device', client_request_id: 'website-gpt-command' },
      headers: { cookie: user.cookie },
    })
    expect(created.status).toBe(200)
    const [task] = await db.select().from(schema.tasks)
    expect(task?.request_payload).toMatchObject({ size: '1664x928', quality: 'medium' })
    expect(await db.execute(sql`SELECT credits FROM cli_test_holds`)).toEqual([{ credits: 10 }])
  })

  it('lists only the GPT tiers and qualities the account may submit', async () => {
    const user = await createUser('gpt-capabilities')
    const { access_token } = await connect(user)
    const caps = await call('GET', '/v1/capabilities', { headers: bearer(access_token) })
    expect(caps.json.data.models[1]).toMatchObject({
      id: 'gpt-image-2.5-flare', image_sizes: ['1K'], qualities: ['auto', 'low', 'medium'],
    })
    billing.members.add(user.id)
    const member = await call('GET', '/v1/capabilities', { headers: bearer(access_token) })
    expect(member.json.data.models[1]).toMatchObject({
      image_sizes: ['1K', '2K', '4K'], qualities: ['auto', 'low', 'medium', 'high'],
    })
    Object.assign(config.gptDirect, { enabled: false })
    const disabled = await call('GET', '/v1/capabilities', { headers: bearer(access_token) })
    expect(disabled.json.data.models[1]).toMatchObject({ image_sizes: ['1K'], qualities: ['auto', 'low', 'medium'] })
  })
})

describe('jobs', () => {
  it('replays the same key to the same job and rejects the key with different parameters', async () => {
    const user = await createUser('replayer')
    const { access_token } = await connect(user)
    const body = imageJob()
    const first = await call('POST', '/v1/image-jobs', { body, headers: bearer(access_token) })
    const again = await call('POST', '/v1/image-jobs', { body, headers: bearer(access_token) })
    expect(again.json.data.job.job_id).toBe(first.json.data.job.job_id)
    expect(await db.select().from(schema.tasks)).toHaveLength(1)
    expect(billing.reservations).toHaveLength(1)
    expect(await db.select().from(schema.cli_jobs)).toHaveLength(1)

    const conflict = await call('POST', '/v1/image-jobs', {
      body: { ...body, prompt: 'something else' },
      headers: bearer(access_token),
    })
    expect(conflict.status).toBe(409)
    expect(conflict.json.error.code).toBe('IDEMPOTENCY_CONFLICT')

    const recovered = await call(
      'GET',
      `/v1/jobs?idempotency_key=${encodeURIComponent(body.idempotency_key)}`,
      { headers: bearer(access_token) },
    )
    expect(recovered.json.data.jobs.map((job: { job_id: string }) => job.job_id)).toEqual([
      first.json.data.job.job_id,
    ])
  })

  it('cancels a queued job once, refuses persisting jobs, and hides other accounts', async () => {
    const owner = await createUser('job-owner')
    const stranger = await createUser('job-stranger')
    const ownerTokens = await connect(owner)
    const strangerTokens = await connect(stranger)
    const created = await call('POST', '/v1/image-jobs', {
      body: imageJob(),
      headers: bearer(ownerTokens.access_token),
    })
    const jobId = created.json.data.job.job_id as string
    expect(created.json.data.job).toMatchObject({ status: 'queued', terminal: false })

    const foreign = await call('GET', `/v1/jobs/${jobId}`, {
      headers: bearer(strangerTokens.access_token),
    })
    expect(foreign.status).toBe(404)
    const foreignCancel = await call('POST', `/v1/jobs/${jobId}/cancel`, {
      headers: bearer(strangerTokens.access_token),
    })
    expect(foreignCancel.status).toBe(404)

    const cancelled = await call('POST', `/v1/jobs/${jobId}/cancel`, {
      headers: bearer(ownerTokens.access_token),
    })
    expect(cancelled.json.data).toMatchObject({ status: 'canceled', terminal: true })
    const repeat = await call('POST', `/v1/jobs/${jobId}/cancel`, {
      headers: bearer(ownerTokens.access_token),
    })
    expect(repeat.json.data.status).toBe('canceled')
    expect(billing.settlements).toEqual([{ taskId: jobId, outcome: 'cancelled' }])

    const persisting = await call('POST', '/v1/image-jobs', {
      body: imageJob(),
      headers: bearer(ownerTokens.access_token),
    })
    const persistingId = persisting.json.data.job.job_id as string
    await db
      .update(schema.tasks)
      .set({ archive_payload: { images: [] } as never })
      .where(eq(schema.tasks.id, persistingId))
    const status = await call('GET', `/v1/jobs/${persistingId}`, {
      headers: bearer(ownerTokens.access_token),
    })
    expect(status.json.data.status).toBe('persisting')
    const refused = await call('POST', `/v1/jobs/${persistingId}/cancel`, {
      headers: bearer(ownerTokens.access_token),
    })
    expect(refused.status).toBe(409)
    expect(refused.json.error.code).toBe('JOB_NOT_CANCELLABLE')
  })

  it('returns artifact identities for a succeeded job and signs downloads per request', async () => {
    const owner = await createUser('artifact-owner')
    const stranger = await createUser('artifact-stranger')
    const ownerTokens = await connect(owner)
    const strangerTokens = await connect(stranger)
    const created = await call('POST', '/v1/image-jobs', {
      body: imageJob(),
      headers: bearer(ownerTokens.access_token),
    })
    const jobId = created.json.data.job.job_id as string
    const now = Date.now()
    await db
      .update(schema.tasks)
      .set({ status: 'completed', completed_at: now })
      .where(eq(schema.tasks.id, jobId))
    await db
      .insert(schema.generation_records)
      .values({
        id: jobId,
        user_id: owner.id,
        provider: 'gemini',
        model: 'gemini-3-pro-image',
        status: 'completed',
        prompt: 'a red fox in snow',
        created_at: now,
        revision: 1n,
      })
      .onConflictDoUpdate({
        target: schema.generation_records.id,
        set: { status: 'completed' },
      })
    const mediaId = crypto.randomUUID()
    await db.insert(schema.media_objects).values({
      id: mediaId,
      user_id: owner.id,
      sha256: 'a'.repeat(64),
      bytes: 1234,
      content_type: 'image/png',
      status: 'ready',
      reserved_bytes: 1234,
      staging_key: `staging/${mediaId}`,
      object_key: `media/${mediaId}`,
      preview_key: `preview/${mediaId}`,
      expires_at: now,
      created_at: now,
      updated_at: now,
    })
    await db
      .insert(schema.generation_images)
      .values({ generation_id: jobId, role: 'output', position: 0, media_id: mediaId })

    const job = await call('GET', `/v1/jobs/${jobId}`, {
      headers: bearer(ownerTokens.access_token),
    })
    expect(job.json.data).toMatchObject({ status: 'succeeded', terminal: true })
    expect(job.json.data).not.toHaveProperty('actual_model')
    const [artifact] = job.json.data.artifacts
    expect(artifact).toEqual({
      artifact_id: `art_${jobId}_0`,
      media_id: mediaId,
      content_type: 'image/png',
    })

    const detail = await call('GET', `/v1/artifacts/${artifact.artifact_id}`, {
      headers: bearer(ownerTokens.access_token),
    })
    expect(detail.json.data).not.toHaveProperty('download_url')
    const download = await call('GET', `/v1/artifacts/${artifact.artifact_id}/download`, {
      headers: bearer(ownerTokens.access_token),
    })
    expect(download.json.data.download_url).toBe(`https://media.test/media/${mediaId}`)
    expect(download.json.data.expires_at).toBeGreaterThan(Date.now())

    const foreign = await call('GET', `/v1/artifacts/${artifact.artifact_id}/download`, {
      headers: bearer(strangerTokens.access_token),
    })
    expect(foreign.status).toBe(404)
    expect(await db.select().from(schema.cli_reference_media)).toHaveLength(0)
    // 生成原件不是 CLI 参考图：media 接口不发它的下载链接，只能走 artifacts。
    const asMedia = await call('GET', `/v1/media/${mediaId}/download`, {
      headers: bearer(ownerTokens.access_token),
    })
    expect(asMedia.status).toBe(404)
    const asReference = await call('POST', '/v1/image-jobs/validate', {
      body: imageJob({ reference_media_ids: [mediaId] }),
      headers: bearer(ownerTokens.access_token),
    })
    expect(asReference.status).toBe(404)

    await db
      .update(schema.generation_records)
      .set({ deleted_at: Date.now() })
      .where(eq(schema.generation_records.id, jobId))
    const afterDelete = await call('GET', `/v1/jobs/${jobId}`, {
      headers: bearer(ownerTokens.access_token),
    })
    expect(afterDelete.json.data.artifacts).toEqual([])
  })
})

describe('reference media', () => {
  it('reserves an upload and refuses another account’s media as a reference', async () => {
    const owner = await createUser('media-owner')
    const stranger = await createUser('media-stranger')
    const ownerTokens = await connect(owner)
    const strangerTokens = await connect(stranger)
    const reserved = await call('POST', '/v1/media', {
      body: { sha256: 'b'.repeat(64), bytes: 2048, content_type: 'image/png' },
      headers: bearer(ownerTokens.access_token),
    })
    expect(reserved.status).toBe(200)
    expect(reserved.json.data).toMatchObject({ status: 'pending' })
    expect(reserved.json.data.upload_url).toBeString()
    const mediaId = reserved.json.data.media_id as string

    const listed = await call('GET', '/v1/media', { headers: bearer(ownerTokens.access_token) })
    expect(listed.json.data.media).toHaveLength(0)

    const foreign = await call('POST', '/v1/image-jobs/validate', {
      body: imageJob({ reference_media_ids: [mediaId] }),
      headers: bearer(strangerTokens.access_token),
    })
    expect(foreign.status).toBe(404)
    expect(foreign.json.error.details).toEqual({ media_ids: [mediaId] })
    const foreignGet = await call('GET', `/v1/media/${mediaId}`, {
      headers: bearer(strangerTokens.access_token),
    })
    expect(foreignGet.status).toBe(404)
  })
})

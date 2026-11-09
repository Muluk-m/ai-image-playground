import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
} from '../../lib/private-overlay'

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
const OPENAI_ENV = 'test-openai-env-key'
const OPENAI_ADMIN = 'test-openai-admin-key'
const OPENAI_NEXT = 'test-openai-next-key'
const GATEWAY_ENV = 'test-gateway-env-key'
const GATEWAY_PROVIDER = 'test-gateway-provider-key'
const GATEWAY_ADMIN = 'test-gateway-admin-key'
const VERTEX_ENV = 'test-vertex-env-key'
const VERTEX_ADMIN = 'test-vertex-admin-key'
const GEMINI_ADMIN = 'test-gemini-admin-key'

process.env.DATABASE_URL = await resetTestDatabase('bff_internal_upstream_secrets')
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = `${import.meta.dir}/../operator-overrides-config.json`
process.env.UPSTREAM_BASE_URL = 'http://127.0.0.1:9'
process.env.UPSTREAM_API_KEY = GATEWAY_ENV
process.env.UPSTREAM_OPENAI_API_KEY = GATEWAY_PROVIDER
process.env.OPENAI_API_KEY = OPENAI_ENV
process.env.VERTEX_API_KEY = VERTEX_ENV
process.env.GEMINI_API_KEY = 'test-gemini-env-key'
process.env.UPSTREAM_SECRETS_MASTER_KEY = MASTER_KEY
process.env.AGENT_CHAT_MODEL = 'fixture-chat-model'
process.env.RESEND_API_KEY = 'fixture-email-key'
process.env.EMAIL_FROM = 'fixture@example.com'
process.env.EMAIL_CODE_SECRET = 'fixture-email-code-secret-at-least-32-characters'
process.env.PORT = '0'
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)

const { close, db, schema } = await import('../../db/client')
const { app } = await import('../../app')
const { config } = await import('../../config')
const { _setChannelsForTesting, initChannels } = await import('../../lib/channels')
const { resolveApiKey } = await import('../../lib/resolveApiKey')
const { gptDirectApiKey } = await import('../../lib/upstream/gpt-routing')
const { _gptDirectRouteForTesting, _resolveUpstreamForTesting } = await import('../../lib/upstream')
const { refreshUpstreamSecrets, resetUpstreamSecretsForTests, testUpstreamSecret } = await import(
  '../../lib/upstream-secrets'
)

const endpoint = 'http://localhost/internal/admin/upstream-secrets'
const auth = { authorization: 'Bearer fixture-service-credential-alpha' }
const secrets = [
  OPENAI_ENV,
  OPENAI_ADMIN,
  OPENAI_NEXT,
  GATEWAY_ENV,
  GATEWAY_PROVIDER,
  GATEWAY_ADMIN,
  VERTEX_ENV,
  VERTEX_ADMIN,
  GEMINI_ADMIN,
]

afterAll(() => close())

beforeEach(async () => {
  process.env.UPSTREAM_SECRETS_MASTER_KEY = MASTER_KEY
  resetUpstreamSecretsForTests()
  _setChannelsForTesting([])
  await db.delete(schema.upstream_api_secrets)
  await db.delete(schema.operator_audits)
  await refreshUpstreamSecrets()
})

function request(path = '', init: RequestInit = {}) {
  return app.handle(
    new Request(`${endpoint}${path}`, {
      ...init,
      headers: { ...auth, 'content-type': 'application/json', ...(init.headers ?? {}) },
    }),
  )
}

function expectNoMaterial(value: unknown) {
  const text = JSON.stringify(value)
  for (const secret of secrets) expect(text).not.toContain(secret)
}

async function put(id: string, apiKey: string) {
  return request(`/${id}`, {
    method: 'PUT',
    headers: { 'x-admin-operator': 'operator-nain' },
    body: JSON.stringify({ apiKey }),
  })
}

describe('upstream secret admin API', () => {
  it('rechecks unchanged ciphertext after the encryption key changes and recovers when restored', async () => {
    expect((await put('openai_direct', OPENAI_ADMIN)).status).toBe(200)
    await refreshUpstreamSecrets()
    expect(gptDirectApiKey()).toBe(OPENAI_ADMIN)
    process.env.UPSTREAM_SECRETS_MASTER_KEY = Buffer.alloc(32, 8).toString('base64')
    try {
      await refreshUpstreamSecrets()
      expect(gptDirectApiKey()).toBe(OPENAI_ENV)
    } finally {
      process.env.UPSTREAM_SECRETS_MASTER_KEY = MASTER_KEY
    }
    await refreshUpstreamSecrets()
    expect(gptDirectApiKey()).toBe(OPENAI_ADMIN)
  })

  it('rejects callers that are not the internal admin service', async () => {
    const response = await app.handle(new Request(endpoint))
    expect(response.status).toBe(401)
    expectNoMaterial(await response.json())
  })

  it('lists configuration state without any key material', async () => {
    const response = await request()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.writable).toBe(true)
    expect(body.disabledReason).toBeNull()
    expect(body.secrets).toEqual([
      expect.objectContaining({
        id: 'openai_direct',
        configured: true,
        source: 'env',
        updatedAt: null,
        updatedBy: null,
      }),
      expect.objectContaining({ id: 'gemini', configured: true, source: 'env' }),
      expect.objectContaining({ id: 'vertex', configured: true, source: 'env' }),
      expect.objectContaining({ id: 'sub2api', configured: true, source: 'env' }),
    ])
    expectNoMaterial(body)
    const keys = JSON.stringify(Object.keys(body.secrets[0] ?? {}).sort())
    expect(keys).not.toContain('apiKey')
    expect(keys).not.toContain('ciphertext')
  })

  it('refuses to store plaintext when the master key is missing or invalid', async () => {
    delete process.env.UPSTREAM_SECRETS_MASTER_KEY
    const missing = await put('openai_direct', OPENAI_ADMIN)
    expect(missing.status).toBe(503)
    const missingBody = await missing.json()
    expect(missingBody.error).toBe('master_key_missing')
    expect(missingBody.message).toContain('UPSTREAM_SECRETS_MASTER_KEY')
    expectNoMaterial(missingBody)
    expect(await db.select().from(schema.upstream_api_secrets)).toHaveLength(0)

    process.env.UPSTREAM_SECRETS_MASTER_KEY = 'bad'
    const invalid = await put('openai_direct', OPENAI_ADMIN)
    expect(invalid.status).toBe(503)
    expect((await invalid.json()).error).toBe('master_key_invalid')
    expect(await db.select().from(schema.upstream_api_secrets)).toHaveLength(0)
    expect(gptDirectApiKey()).toBe(OPENAI_ENV)
  })

  it('encrypts a replacement, hides it from the API and audit, and falls back when cleared', async () => {
    const saved = await put('openai_direct', OPENAI_ADMIN)
    expect(saved.status).toBe(200)
    const savedBody = await saved.json()
    expect(savedBody.secrets[0]).toEqual(
      expect.objectContaining({
        id: 'openai_direct',
        configured: true,
        source: 'admin',
        updatedBy: 'operator-nain',
      }),
    )
    expect(typeof savedBody.secrets[0].updatedAt).toBe('number')
    expectNoMaterial(savedBody)

    const [row] = await db.select().from(schema.upstream_api_secrets)
    expect(row?.ciphertext).not.toContain(OPENAI_ADMIN)
    expect(row?.nonce).not.toContain(OPENAI_ADMIN)
    expect(row?.tag).not.toContain(OPENAI_ADMIN)
    expect(JSON.stringify(row)).not.toContain(OPENAI_ADMIN)

    const [audit] = await db.select().from(schema.operator_audits)
    expect(audit).toEqual(
      expect.objectContaining({
        operator_id: 'operator-nain',
        action: 'upstream_secret.replace',
        target_type: 'upstream_secret',
        target_id: 'openai_direct',
        details: { slot: 'openai_direct' },
      }),
    )
    expectNoMaterial(audit)

    expect(gptDirectApiKey()).toBe(OPENAI_ADMIN)
    expect(config.gptDirect.apiKey).toBe(OPENAI_ENV)

    const cleared = await request('/openai_direct', {
      method: 'DELETE',
      headers: { 'x-admin-operator': 'operator-nain' },
    })
    expect(cleared.status).toBe(200)
    const clearedBody = await cleared.json()
    expect(clearedBody.secrets[0]).toEqual(
      expect.objectContaining({
        id: 'openai_direct',
        source: 'env',
        configured: true,
        updatedAt: null,
        updatedBy: null,
      }),
    )
    expectNoMaterial(clearedBody)
    expect(await db.select().from(schema.upstream_api_secrets)).toHaveLength(0)
    expect(gptDirectApiKey()).toBe(OPENAI_ENV)
    const [clearAudit] = await db
      .select()
      .from(schema.operator_audits)
      .where(eq(schema.operator_audits.action, 'upstream_secret.clear'))
    expect(clearAudit?.details).toEqual({ slot: 'openai_direct' })
  })

  it('applies a new key to the next resolve and leaves an already resolved route on the old key', async () => {
    _setChannelsForTesting([
      {
        id: 'vertex-images',
        kind: 'gemini-queue',
        label: 'Gemini',
        baseUrl: 'https://vertex.example/v1/publishers/google',
        auth: { type: 'bearer', secretRef: 'VERTEX_API_KEY', secret: VERTEX_ENV },
        allowedPaths: ['models'],
        models: [{ id: 'gemini-nano-banana-2.1', label: 'Nano', capabilities: ['generate'] }],
        defaults: {},
      },
    ])

    const inflight = _gptDirectRouteForTesting('gpt-image-2.5-flare')
    expect(inflight.key).toBe(OPENAI_ENV)
    expect((await put('openai_direct', OPENAI_ADMIN)).status).toBe(200)
    expect(inflight.key).toBe(OPENAI_ENV)
    expect(_gptDirectRouteForTesting('gpt-image-2.5-flare').key).toBe(OPENAI_ADMIN)
    expect(gptDirectApiKey()).toBe(OPENAI_ADMIN)

    expect(_resolveUpstreamForTesting('gemini', 'gemini-nano-banana-2.1').key).toBe(VERTEX_ENV)
    expect((await put('vertex', VERTEX_ADMIN)).status).toBe(200)
    expect(_resolveUpstreamForTesting('gemini', 'gemini-nano-banana-2.1').key).toBe(VERTEX_ADMIN)

    expect(resolveApiKey('openai-compat')).toBe(GATEWAY_PROVIDER)
    expect((await put('sub2api', GATEWAY_ADMIN)).status).toBe(200)
    expect(resolveApiKey('openai-compat')).toBe(GATEWAY_PROVIDER)
    const previousOpenAiGateway = config.upstream.openaiApiKey
    config.upstream.openaiApiKey = ''
    expect(resolveApiKey('openai-compat')).toBe(GATEWAY_ADMIN)
    expect(_resolveUpstreamForTesting('openai-compat', 'not-a-channel-model').key).toBe(
      GATEWAY_ADMIN,
    )
    config.upstream.openaiApiKey = previousOpenAiGateway

    expect((await request('/sub2api', { method: 'DELETE' })).status).toBe(200)
    expect(resolveApiKey('openai-compat')).toBe(GATEWAY_PROVIDER)

    delete process.env.UPSTREAM_SECRETS_MASTER_KEY
    await refreshUpstreamSecrets()
    expect(gptDirectApiKey()).toBe(OPENAI_ENV)
    expect(_resolveUpstreamForTesting('gemini', 'gemini-nano-banana-2.1').key).toBe(VERTEX_ENV)
    expect(resolveApiKey('openai-compat')).toBe(GATEWAY_PROVIDER)
  })

  it('loads a secret-gated channel from the admin key when the env var is empty', async () => {
    const previousBase = process.env.VERTEX_BASE_URL
    delete process.env.VERTEX_API_KEY
    process.env.VERTEX_BASE_URL = 'https://vertex.example/v1/publishers/google'
    try {
      expect((await put('vertex', VERTEX_ADMIN)).status).toBe(200)
      const loaded = initChannels()
      const vertex = loaded.channels.find((channel) => channel.id === 'vertex-images')
      expect(vertex?.auth.secret ?? '').toBe('')
      expect(_resolveUpstreamForTesting('gemini', 'gemini-nano-banana-2.1').key).toBe(VERTEX_ADMIN)

      process.env.VERTEX_API_KEY = VERTEX_ENV
      expect((await request('/vertex', { method: 'DELETE' })).status).toBe(200)
      initChannels()
      expect(_resolveUpstreamForTesting('gemini', 'gemini-nano-banana-2.1').key).toBe(VERTEX_ENV)
    } finally {
      process.env.VERTEX_API_KEY = VERTEX_ENV
      if (previousBase === undefined) delete process.env.VERTEX_BASE_URL
      else process.env.VERTEX_BASE_URL = previousBase
    }
  })

  it('replaces one slot without echoing the new value, including validation errors', async () => {
    expect(await put('openai_direct', OPENAI_ADMIN)).toMatchObject({ status: 200 })
    const replaced = await put('openai_direct', OPENAI_NEXT)
    expect(replaced.status).toBe(200)
    expectNoMaterial(await replaced.json())
    expect(gptDirectApiKey()).toBe(OPENAI_NEXT)
    const [row] = await db.select().from(schema.upstream_api_secrets)
    expect(JSON.stringify(row)).not.toContain(OPENAI_NEXT)
    expect(JSON.stringify(row)).not.toContain(OPENAI_ADMIN)

    const leaked = `LEAKMARKER-${'k'.repeat(4100)}`
    const invalid = await put('gemini', leaked)
    expect(invalid.status).toBe(400)
    const invalidText = await invalid.text()
    expect(invalidText).not.toContain('LEAKMARKER')
    expect(invalidText).toContain('invalid_secret')
    expect(invalidText).not.toContain('apiKey')
  })

  it('probes OpenAI and Gemini with read-only requests and never returns the key', async () => {
    const seen: Array<{ url: string; authorization: string | null; goog: string | null }> = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const headers = new Headers(init?.headers)
      seen.push({
        url: String(input),
        authorization: headers.get('authorization'),
        goog: headers.get('x-goog-api-key'),
      })
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    try {
      const openai = await request('/openai_direct/test', {
        method: 'POST',
        body: JSON.stringify({ apiKey: OPENAI_ADMIN }),
      })
      expect(openai.status).toBe(200)
      expect(await openai.json()).toEqual({ ok: true, httpStatus: 200 })
      expect(seen[0]?.url).toBe(`${config.gptDirect.baseUrl}/models`)
      expect(seen[0]?.authorization).toBe(`Bearer ${OPENAI_ADMIN}`)
      expect(seen[0]?.url).not.toContain(OPENAI_ADMIN)

      const gemini = await request('/gemini/test', {
        method: 'POST',
        body: JSON.stringify({ apiKey: GEMINI_ADMIN }),
      })
      expect(await gemini.json()).toEqual({ ok: true, httpStatus: 200 })
      expect(seen[1]?.url).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
      )
      expect(seen[1]?.goog).toBe(GEMINI_ADMIN)
      expect(seen[1]?.url).not.toContain(GEMINI_ADMIN)
    } finally {
      globalThis.fetch = original
    }

    const recorded: unknown[] = []
    const failed = await testUpstreamSecret('vertex', VERTEX_ADMIN, {
      fetch: async () => {
        throw new Error(`socket ${VERTEX_ADMIN}`)
      },
      record: (fields) => recorded.push(fields),
    })
    expect(failed).toEqual({ ok: false, httpStatus: null })
    expectNoMaterial(recorded)
    expect(JSON.stringify(recorded)).not.toContain(VERTEX_ADMIN)
  })
})

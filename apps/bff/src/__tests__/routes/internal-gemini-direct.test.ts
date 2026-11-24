import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { GeminiDirectAdminView } from '@image-playground/shared'

const KEY_A = 'AIzaSy-test-gemini-key-aaaa'
const KEY_B = 'AIzaSy-test-gemini-key-bbbb'
const MASTER_KEY = 'cd'.repeat(32)
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII='

process.env.DATABASE_URL = await resetTestDatabase('bff_gemini_direct_pool')
process.env.UPSTREAM_BASE_URL = 'https://sub2api.example.com'
process.env.UPSTREAM_API_KEY = 'sub2api-key'
process.env.VERTEX_BASE_URL =
  'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google'
process.env.VERTEX_API_KEY = ''
delete process.env.VERTEX_API_KEYS
delete process.env.VERTEX_API_KEY_BUDGETS_USD
process.env.UPSTREAM_SECRETS_MASTER_KEY = MASTER_KEY
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.PORT = '0'

const { app } = await import('../../app')
const { close, db, schema } = await import('../../db/client')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { callUpstream, setUpstreamFetchForTesting } = await import('../../lib/upstream')
const { _resetGeminiBudgetCacheForTesting, estimateGeminiCostMicroUsd, readGeminiUsage } =
  await import('../../lib/upstream/gemini-budget')
const { _resetGeminiDirectAdminCacheForTesting, refreshGeminiDirectKeys } = await import(
  '../../lib/upstream/gemini-direct-admin'
)
const { geminiFingerprintOf, resetAdminGeminiDirectKeySnapshot } = await import(
  '../../lib/upstream/gemini-key-config'
)
const { GeminiDirectKeysExhaustedError } = await import('../../lib/upstream/gemini-keys')
const { setVertexRateLimitBackoffForTesting } = await import('../../lib/upstream/vertex')

type InternalChannel = import('../../lib/channels').InternalChannel

const auth = {
  authorization: 'Bearer fixture-service-credential-alpha',
  'content-type': 'application/json',
}

const vertexChannel: InternalChannel = {
  id: 'vertex-images',
  kind: 'gemini-queue',
  label: 'Gemini',
  baseUrl: 'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google',
  auth: { type: 'bearer', secretRef: 'VERTEX_API_KEY', secret: '' },
  allowedPaths: [
    'models/gemini-nano-banana-2.1:generateContent',
    'models/gemini-3-pro-image:generateContent',
  ],
  models: [
    {
      id: 'gemini-nano-banana-2.1',
      label: 'Nano Banana 2.1',
      capabilities: ['generate', 'edit', 'size'],
      imageSizes: ['1K', '2K'],
    },
    {
      id: 'gemini-3-pro-image',
      label: 'Nano Banana Pro',
      capabilities: ['generate', 'edit', 'size'],
      imageSizes: ['1K', '2K'],
    },
  ],
  defaults: { apiMode: 'images', timeout: 600 },
  modelMaxConcurrency: {
    'gemini-nano-banana-2.1': 2,
    'gemini-3-pro-image': 2,
  },
}

function request(path: string, method = 'GET', body?: unknown, withAuth = true) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(withAuth ? { ...auth, 'x-admin-operator': 'ops' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
}

function okVertexResponse() {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ inlineData: { mimeType: 'image/png', data: TINY_PNG_B64 } }],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 200,
        candidatesTokenCount: 1200,
        totalTokenCount: 1400,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

beforeEach(async () => {
  setUpstreamFetchForTesting(undefined)
  setVertexRateLimitBackoffForTesting([1])
  resetAdminGeminiDirectKeySnapshot()
  _resetGeminiDirectAdminCacheForTesting()
  _resetGeminiBudgetCacheForTesting()
  _setChannelsForTesting([vertexChannel])
  await db.delete(schema.operator_audits)
  await db.delete(schema.gemini_direct_admin_keys)
  await db.delete(schema.gemini_direct_key_state)
  await db.delete(schema.gemini_direct_budget_holds)
  await db.delete(schema.gemini_direct_usage)
})

afterAll(async () => {
  setUpstreamFetchForTesting(undefined)
  setVertexRateLimitBackoffForTesting(undefined)
  await close()
})

describe('Gemini direct key pool & stats', () => {
  it('manages keys via internal admin API without leaking plaintext secrets', async () => {
    expect((await request('/internal/admin/gemini-direct', 'GET', undefined, false)).status).toBe(
      401,
    )

    const createA = await request('/internal/admin/gemini-direct/keys', 'POST', {
      apiKey: KEY_A,
      budgetUsd: 100,
    })
    expect(createA.status).toBe(200)
    const rawA = await createA.text()
    expect(rawA).not.toContain(KEY_A)

    const createB = await request('/internal/admin/gemini-direct/keys', 'POST', {
      apiKey: KEY_B,
      budgetUsd: 300,
    })
    expect(createB.status).toBe(200)
    const panel = (await createB.json()) as GeminiDirectAdminView
    expect(panel.source).toBe('admin')
    expect(panel.keys).toHaveLength(2)
    expect(panel.keys.map((k) => k.ordinal)).toEqual([1, 2])
    expect(panel.total_budget_micro_usd).toBe(400_000_000)

    // Invalid budgetUsd validation error must NEVER echo plaintext apiKey
    const badReq = await request('/internal/admin/gemini-direct/keys', 'POST', {
      apiKey: 'AIzaSy-must-not-echo-validation',
      budgetUsd: 'not-a-number',
    })
    expect(badReq.status).toBe(400)
    expect(await badReq.text()).not.toContain('AIzaSy-must-not-echo-validation')

    // Duplicate key rejected
    const dup = await request('/internal/admin/gemini-direct/keys', 'POST', {
      apiKey: KEY_A,
      budgetUsd: 50,
    })
    expect(dup.status).toBe(409)

    // Reorder keys with matching revision
    const idA = panel.keys[0]!.id!
    const idB = panel.keys[1]!.id!
    const reordered = await request('/internal/admin/gemini-direct/keys/order', 'POST', {
      ids: [idB, idA],
      revision: panel.revision,
    })
    expect(reordered.status).toBe(200)
    const afterOrder = (await reordered.json()) as GeminiDirectAdminView
    expect(afterOrder.keys.map((k) => k.id)).toEqual([idB, idA])

    // Stale revision rejected
    const staleOrder = await request('/internal/admin/gemini-direct/keys/order', 'POST', {
      ids: [idA, idB],
      revision: panel.revision,
    })
    expect(staleOrder.status).toBe(409)

    // Update budget & enabled
    const updated = await request(`/internal/admin/gemini-direct/keys/${idA}`, 'PATCH', {
      budgetUsd: 250,
      enabled: false,
    })
    expect(updated.status).toBe(200)
    const afterUpdate = (await updated.json()) as GeminiDirectAdminView
    const rowA = afterUpdate.keys.find((k) => k.id === idA)!
    expect(rowA.budget_usd).toBe(250)
    expect(rowA.enabled).toBe(false)
    expect(rowA.status).toBe('off')

    // Delete key
    const deleted = await request(`/internal/admin/gemini-direct/keys/${idA}`, 'DELETE')
    expect(deleted.status).toBe(200)
    const afterDelete = (await deleted.json()) as GeminiDirectAdminView
    expect(afterDelete.keys.map((k) => k.id)).toEqual([idB])
  })

  it('switches immediately to the next key on 429 cooldown and aggregates key/day/model stats', async () => {
    await request('/internal/admin/gemini-direct/keys', 'POST', { apiKey: KEY_A, budgetUsd: 100 })
    await request('/internal/admin/gemini-direct/keys', 'POST', { apiKey: KEY_B, budgetUsd: 100 })
    await refreshGeminiDirectKeys()

    const seenKeys: string[] = []
    setUpstreamFetchForTesting(async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const usedKey = headers['x-goog-api-key'] ?? ''
      seenKeys.push(usedKey)
      if (usedKey === KEY_A) {
        return new Response(
          JSON.stringify({
            error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'rate limit' },
          }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        )
      }
      return okVertexResponse()
    })

    const result = await callUpstream({
      provider: 'gemini',
      model: 'gemini-nano-banana-2.1',
      request: { prompt: 'draw a leaf', n: 1, image_size: '1K' },
      taskId: 'task-gemini-1',
    })
    expect(result.payload).toBeTruthy()
    expect(seenKeys).toEqual([KEY_A, KEY_B])

    const panelRes = await request('/internal/admin/gemini-direct?days=7')
    expect(panelRes.status).toBe(200)
    const panel = (await panelRes.json()) as GeminiDirectAdminView

    const fpA = geminiFingerprintOf(KEY_A).fingerprint
    const fpB = geminiFingerprintOf(KEY_B).fingerprint
    const keyAView = panel.keys.find((k) => k.fingerprint === fpA)!
    const keyBView = panel.keys.find((k) => k.fingerprint === fpB)!

    expect(keyAView.status).toBe('cooldown')
    expect(keyAView.requests).toBe(1)
    expect(keyAView.rate_limited).toBe(1)
    expect(keyAView.succeeded).toBe(0)

    expect(keyBView.status).toBe('available')
    expect(keyBView.requests).toBe(1)
    expect(keyBView.succeeded).toBe(1)
    expect(keyBView.images).toBe(1)
    expect(keyBView.spent_micro_usd).toBeGreaterThan(0)

    expect(panel.window_requests).toBe(2)
    expect(panel.window_succeeded).toBe(1)
    expect(panel.window_images).toBe(1)
    expect(panel.window_rate_limited).toBe(1)
    expect(panel.by_model).toHaveLength(1)
    expect(panel.by_model[0]!.model).toBe('gemini-nano-banana-2.1')

    // Restore cooled-down key A and verify audit record written
    const restored = await request(`/internal/admin/gemini-direct/keys/${fpA}/restore`, 'POST')
    expect(restored.status).toBe(200)
    const afterRestore = (await restored.json()) as GeminiDirectAdminView
    expect(afterRestore.keys.find((k) => k.fingerprint === fpA)!.status).toBe('available')
    const audits = await db.select().from(schema.operator_audits)
    expect(audits.some((row) => row.action === 'gemini_direct_key.restore')).toBe(true)
  })

  it('disables invalid keys, enforces monthly budget cap, and throws non-retryable exhausted error', async () => {
    await request('/internal/admin/gemini-direct/keys', 'POST', { apiKey: KEY_A, budgetUsd: 1 })
    await refreshGeminiDirectKeys()

    const fpA = geminiFingerprintOf(KEY_A).fingerprint
    // Fill Key A's $1 monthly budget
    await db.insert(schema.gemini_direct_usage).values({
      id: 'usage-cap-1',
      task_id: 'old-task',
      model: 'gemini-3-pro-image',
      image_size: '1K',
      images: 10,
      input_tokens: 1000,
      output_tokens: 10000,
      cost_micro_usd: 1_000_000,
      estimated: false,
      status: 'ok',
      upstream_status: 200,
      key_fingerprint: fpA,
      created_at: Date.now(),
    })
    _resetGeminiBudgetCacheForTesting()

    let fetchCalls = 0
    setUpstreamFetchForTesting(async () => {
      fetchCalls += 1
      return okVertexResponse()
    })

    let caught: unknown
    try {
      await callUpstream({
        provider: 'gemini',
        model: 'gemini-3-pro-image',
        request: { prompt: 'draw a tree', n: 1, image_size: '1K' },
      })
    } catch (err) {
      caught = err
    }
    expect(fetchCalls).toBe(0)
    expect(caught).toBeInstanceOf(GeminiDirectKeysExhaustedError)
    expect((caught as GeminiDirectKeysExhaustedError).retryable).toBe(false)
    expect((caught as GeminiDirectKeysExhaustedError).message).not.toMatch(/密钥|预算|后台/)
  })

  it('parses usageMetadata and estimates per-model/resolution cost cleanly', () => {
    const usage = readGeminiUsage({
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500, thoughtsTokenCount: 200 },
    })
    expect(usage).toEqual({ promptTokens: 1000, outputTokens: 700 })
    expect(estimateGeminiCostMicroUsd('gemini-3-pro-image', '2K', 1, usage)).toBe(134_000 + 2000)
    expect(estimateGeminiCostMicroUsd('gemini-nano-banana-2.1', '1K', 2, null)).toBe(78_000)
  })
})

import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentModelSettingsView } from '@image-playground/shared'

process.env.DATABASE_URL = await resetTestDatabase('agent_model_settings')
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'legacy-fixture-key'
process.env.AGENT_CHAT_MODEL = 'gpt-6-luna'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = ''
process.env.AGENT_PROVIDER_TEST_API_KEY = 'provider-fixture-secret'
const { app } = await import('../../app')
const { _setSafeFetchForTesting } = await import('../../lib/safeFetch')
const { db, schema, close } = await import('../../db/client')
const { resolveConfiguredAgentRuntime } = await import('../../lib/agent/model-settings-store')
const { agentStreamFn, setAgentFetchForTesting } = await import('../../lib/agent/model')
const { completionStream } = await import('../helpers/agentStubs')

beforeEach(async () => {
  _setSafeFetchForTesting({ resolve: async () => [{ address: '8.8.8.8', family: 4 }] })
  await db.delete(schema.agent_model_settings)
  await db.delete(schema.operator_audits)
})
afterEach(() => {
  setAgentFetchForTesting()
  _setSafeFetchForTesting()
})
afterAll(close)
const endpoint = 'http://localhost/internal/admin/agent-models'
function request(method = 'GET', body?: unknown, authenticated = true) {
  return app.handle(
    new Request(endpoint, {
      method,
      headers: {
        ...(authenticated ? { authorization: 'Bearer fixture-service-credential-alpha' } : {}),
        'content-type': 'application/json',
        'x-admin-operator': 'operator-test',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}
async function initial(): Promise<AgentModelSettingsView> {
  return (await request()).json()
}

it('requires internal authentication and never returns credential values', async () => {
  expect((await request('GET', undefined, false)).status).toBe(401)
  expect((await request('PUT', {}, false)).status).toBe(401)
  const view = await initial()
  expect(view.revision).toBe(0)
  expect(view.settings.profiles.fast).toEqual({
    providerId: 'upstream-gateway',
    modelId: 'gpt-6-luna',
    reasoning: 'low',
  })
  expect(view.templates.some((item) => item.id === 'anthropic')).toBe(true)
  expect(view.templates.some((item) => item.id === 'google')).toBe(false)
  expect(JSON.stringify(view)).not.toContain('legacy-fixture-key')
  expect(JSON.stringify(view)).not.toContain('provider-fixture-secret')
})

it('persists independent model effort per product depth, audits changes and rejects stale writes', async () => {
  const view = await initial()
  view.settings.profiles.deep = { ...view.settings.profiles.fast, reasoning: 'high' }
  const response = await request('PUT', { revision: view.revision, settings: view.settings })
  expect(response.status).toBe(200)
  const saved = await initial()
  expect(saved.revision).toBe(1)
  expect(saved.settings.profiles.deep.modelId).toBe(saved.settings.profiles.fast.modelId)
  expect(saved.settings.profiles.deep.reasoning).toBe('high')
  expect((await request('PUT', { revision: 0, settings: view.settings })).status).toBe(409)
  const audits = await db.select().from(schema.operator_audits)
  expect(audits).toHaveLength(1)
  expect(audits[0]?.operator_id).toBe('operator-test')
  expect(JSON.stringify(audits)).not.toContain('legacy-fixture-key')
})

it('only one concurrent writer can replace a revision', async () => {
  const { settings } = await initial()
  const responses = await Promise.all([
    request('PUT', { revision: 0, settings }),
    request('PUT', { revision: 0, settings }),
  ])
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
})

it('rejects missing references, unsupported effort, plaintext remote endpoints and literal credentials atomically', async () => {
  const { settings } = await initial()
  for (const mutate of [
    (s: typeof settings) => {
      s.profiles.fast.modelId = 'missing'
    },
    (s: typeof settings) => {
      s.profiles.fast.providerId = 'missing'
    },
    (s: typeof settings) => {
      s.profiles.fast.reasoning = 'max'
    },
    (s: typeof settings) => {
      s.providers[0]!.baseUrl = 'http://remote.example/v1'
    },
    (s: typeof settings) => {
      s.providers[0]!.baseUrl = 'https://changed.example/v1'
    },
    (s: typeof settings) => {
      s.providers[0]!.secretRef = 'sk-literal-secret'
    },
    (s: typeof settings) => {
      s.providers[0]!.models[0]!.maxTokens = 0
    },
    (s: typeof settings) => {
      Object.assign(s.providers[0]!, { apiKey: 'secret' })
    },
  ]) {
    const next = structuredClone(settings)
    mutate(next)
    expect((await request('PUT', { revision: 0, settings: next })).status).toBe(400)
  }
  expect((await initial()).revision).toBe(0)
  expect(await db.select().from(schema.operator_audits)).toHaveLength(0)
})

it('freezes provider, credential, model and effort for the whole turn while the next turn picks up edits', async () => {
  const { settings } = await initial()
  settings.providers.push({
    id: 'second',
    name: 'Second',
    template: 'custom',
    baseUrl: 'https://provider.example/v1',
    secretRef: 'AGENT_PROVIDER_TEST_API_KEY',
    models: [
      {
        id: 'same-model',
        name: 'Same model',
        api: 'openai-completions',
        contextWindow: 64000,
        maxTokens: 8000,
        imageInput: true,
        reasoningLevels: ['off', 'low', 'high'],
      },
    ],
  })
  settings.profiles.deep = { providerId: 'second', modelId: 'same-model', reasoning: 'low' }
  expect((await request('PUT', { revision: 0, settings })).status).toBe(200)
  const first = await resolveConfiguredAgentRuntime('deep')
  settings.profiles.deep.reasoning = 'high'
  settings.providers[1]!.baseUrl = 'https://next.example/v1'
  expect((await request('PUT', { revision: 1, settings })).status).toBe(200)
  const next = await resolveConfiguredAgentRuntime('deep')
  expect(next.effort).toBe('high')
  expect(first.effort).toBe('low')
  const calls: { url: string; body: Record<string, unknown>; authorization: string | null }[] = []
  setAgentFetchForTesting(async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
      authorization: new Headers(init?.headers).get('authorization'),
    })
    return completionStream('ok')
  })
  for (const runtime of [first, next]) {
    const stream = await agentStreamFn('deep', {}, runtime)(
      runtime.model,
      { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] },
      { reasoning: runtime.effort === 'off' ? undefined : runtime.effort },
    )
    expect((await stream.result()).stopReason).toBe('stop')
  }
  expect(calls.map((call) => call.url)).toEqual([
    'https://8.8.8.8/v1/chat/completions',
    'https://8.8.8.8/v1/chat/completions',
  ])
  expect(calls.map((call) => call.body.reasoning_effort)).toEqual(['low', 'high'])
  expect(calls[0]?.authorization).toBe('Bearer provider-fixture-secret')
})

it.each([
  ['openai', 'openai-responses', '/responses'],
  ['anthropic', 'anthropic-messages', '/messages'],
] as const)('dispatches %s through its native Pi protocol with the configured credential', async (template, api, path) => {
  const view = await initial()
  const model = view.templates
    .find((item) => item.id === template)!
    .models.find((item) => item.api === api && item.reasoningLevels.includes('low'))!
  expect(model).toBeDefined()
  view.settings.providers.push({
    id: 'native',
    name: 'Native',
    template,
    baseUrl: 'https://native.example',
    secretRef: 'AGENT_PROVIDER_TEST_API_KEY',
    models: [],
  })
  view.settings.profiles.fast = { providerId: 'native', modelId: model.id, reasoning: 'low' }
  expect((await request('PUT', { revision: 0, settings: view.settings })).status).toBe(200)
  const runtime = await resolveConfiguredAgentRuntime('fast')
  expect(runtime.model.provider).toBe(template)
  expect(runtime.providerId).toBe('native')
  let observed: { url: string; body: Record<string, unknown>; headers: Headers } | undefined
  let dispatches = 0
  setAgentFetchForTesting(async (input, init) => {
    observed = {
      url: String(input),
      body: JSON.parse(String(init?.body)),
      headers: new Headers(init?.headers),
    }
    return Response.json({ error: { message: 'fixture rejection' } }, { status: 400 })
  })
  const stream = await agentStreamFn(
    'fast',
    {
      onDispatch: async () => {
        dispatches++
      },
    },
    runtime,
  )(
    runtime.model,
    { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] },
    { reasoning: 'low' },
  )
  expect((await stream.result()).stopReason).toBe('error')
  expect(observed?.url).toContain(path)
  expect(dispatches).toBe(1)
  if (template === 'openai') {
    expect(observed?.headers.get('authorization')).toBe('Bearer provider-fixture-secret')
    expect(observed?.body.reasoning).toMatchObject({ effort: 'low' })
  } else if (template === 'anthropic') {
    expect(observed?.headers.get('x-api-key')).toBe('provider-fixture-secret')
    expect(observed?.body.thinking).toBeDefined()
  }
})

it('fails an unconfigured selected provider without borrowing the gateway credential', async () => {
  const { settings } = await initial()
  settings.providers[0]!.secretRef = 'AGENT_PROVIDER_MISSING_API_KEY'
  expect((await request('PUT', { revision: 0, settings })).status).toBe(200)
  expect((await initial()).credentialReady['upstream-gateway']).toBe(false)
  await expect(resolveConfiguredAgentRuntime('fast')).rejects.toThrow('尚未配置服务端密钥')
})

it('rejects protocols that cannot participate in request budget and dispatch accounting', async () => {
  const { settings } = await initial()
  Object.assign(settings.providers[0]!.models[0]!, { api: 'google-generative-ai' })
  expect((await request('PUT', { revision: 0, settings })).status).toBe(400)
})

it('preserves the legacy system role when the selected gateway effort is off', async () => {
  const runtime = await resolveConfiguredAgentRuntime()
  let payload: { messages: { role: string }[] } | undefined
  setAgentFetchForTesting(async (_input, init) => {
    payload = JSON.parse(String(init?.body))
    return completionStream('ok')
  })
  const stream = await agentStreamFn(
    undefined,
    {},
    runtime,
  )(runtime.model, {
    systemPrompt: 'System instructions',
    messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
  })
  expect((await stream.result()).stopReason).toBe('stop')
  expect(payload?.messages[0]?.role).toBe('system')
})

it('rejects non-provider environment secrets, private endpoints and text-only profile models', async () => {
  for (const secretRef of ['DATABASE_URL', 'INTERNAL_API_TOKEN', 'AWS_SECRET_ACCESS_KEY']) {
    const { settings } = await initial()
    settings.providers[0]!.secretRef = secretRef
    expect((await request('PUT', { revision: 0, settings })).status).toBe(400)
  }
  for (const baseUrl of ['https://127.0.0.1/v1', 'https://169.254.169.254', 'https://[::1]/v1']) {
    const { settings } = await initial()
    settings.providers[0]!.baseUrl = baseUrl
    settings.providers[0]!.secretRef = 'OPENAI_API_KEY'
    expect((await request('PUT', { revision: 0, settings })).status).toBe(400)
  }
  const { settings } = await initial()
  settings.providers[0]!.models[0]!.imageInput = false
  expect((await request('PUT', { revision: 0, settings })).status).toBe(400)
})

it('lets admin repair a damaged stored configuration without silently using fallback models for turns', async () => {
  const { settings } = await initial()
  await request('PUT', { revision: 0, settings })
  await db.update(schema.agent_model_settings).set({ settings: {} as typeof settings })
  const damaged = await initial()
  expect(damaged.validationError).toContain('保存的模型配置无效')
  expect(damaged.revision).toBe(1)
  await expect(resolveConfiguredAgentRuntime('fast')).rejects.toThrow('保存的模型配置无效')
  expect(
    (await request('PUT', { revision: damaged.revision, settings: damaged.settings })).status,
  ).toBe(200)
  expect((await initial()).validationError).toBeUndefined()
})

it('preserves an existing deployment HTTP gateway while rejecting newly configured HTTP targets', async () => {
  const { config } = await import('../../config')
  const original = config.upstream.baseUrl
  try {
    config.upstream.baseUrl = 'http://gateway:8080'
    const { settings } = await initial()
    expect((await request('PUT', { revision: 0, settings })).status).toBe(200)
    expect((await resolveConfiguredAgentRuntime()).trustedGateway).toBe(true)
    settings.providers[0]!.baseUrl = 'http://other-gateway:8080/v1'
    settings.providers[0]!.secretRef = 'UPSTREAM_API_KEY'
    expect((await request('PUT', { revision: 1, settings })).status).toBe(400)
  } finally {
    config.upstream.baseUrl = original
  }
})

import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test'
import { Agent } from '@earendil-works/pi-agent-core'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  type AgentConfiguredModel,
  type AgentModelSettingsView,
  MODEL_REASONING_LEVELS,
} from '@image-playground/shared'

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

const nativeProtocols = [
  {
    template: 'openai',
    api: 'openai-responses',
    path: '/responses',
    modelId: 'gpt-5.1',
  },
  {
    template: 'anthropic',
    api: 'anthropic-messages',
    path: '/messages',
    modelId: 'claude-opus-4-6',
  },
] as const

it.each(
  nativeProtocols.flatMap((protocol) =>
    (['custom', 'builtin', 'override', 'override-off-only'] as const).flatMap((source) =>
      (source === 'override-off-only' ? (['off'] as const) : (['off', 'low'] as const)).map((effort) => [source, effort, protocol] as const),
    ),
  ),
)('dispatches %s models at %s through native Pi protocol %j', async (source, effort, { template, api, path, modelId }) => {
  const view = await initial()
  const model = view.templates
    .find((item) => item.id === template)!
    .models.find((item) => item.id === modelId)!
  expect(model).toBeDefined()
  const selectedModel: AgentConfiguredModel = {
    ...model,
    id: source === 'custom' ? 'custom-native' : model.id,
    reasoningLevels: source === 'override-off-only' ? ['off'] : ['off', 'low'],
  }
  view.settings.providers.push({
    id: 'native',
    name: 'Native',
    template: source === 'custom' ? 'custom' : template,
    baseUrl: 'https://native.example',
    secretRef: 'AGENT_PROVIDER_TEST_API_KEY',
    models: source === 'builtin' ? [] : [selectedModel],
  })
  view.settings.profiles.fast = {
    providerId: 'native',
    modelId: selectedModel.id,
    reasoning: effort,
  }
  expect((await request('PUT', { revision: 0, settings: view.settings })).status).toBe(200)
  const runtime = await resolveConfiguredAgentRuntime('fast')
  expect(runtime.model.api).toBe(api)
  expect(runtime.model.provider).toBe(source === 'custom' ? 'native' : template)
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
    { reasoning: effort === 'off' ? undefined : effort },
  )
  expect((await stream.result()).stopReason).toBe('error')
  expect(observed?.url).toContain(path)
  expect(observed?.body.model).toBe(selectedModel.id)
  expect(observed?.body.reasoning_effort).toBeUndefined()
  expect(dispatches).toBe(1)
  if (template === 'openai') {
    expect(observed?.headers.get('authorization')).toBe('Bearer provider-fixture-secret')
    expect(observed?.body.reasoning).toMatchObject({ effort: effort === 'off' ? 'none' : effort })
    expect(observed?.body.thinking).toBeUndefined()
  } else if (template === 'anthropic') {
    expect(observed?.headers.get('x-api-key')).toBe('provider-fixture-secret')
    expect(runtime.model.thinkingLevelMap?.off).toBeUndefined()
    expect(observed?.body.reasoning).toBeUndefined()
    if (effort === 'off') expect(observed?.body.thinking).toEqual({ type: 'disabled' })
    else if (source === 'custom')
      expect(observed?.body.thinking).toMatchObject({
        type: 'enabled',
        budget_tokens: expect.any(Number),
      })
    else {
      expect(observed?.body.thinking).toMatchObject({ type: 'adaptive' })
      expect(observed?.body.output_config).toEqual({ effort: 'low' })
    }
  }
})

it.each(['o1', 'gpt-6-astra'])('rejects builtin %s off even when its override only declares off', async (modelId) => {
  const view = await initial()
  const model = view.templates
    .find((item) => item.id === 'openai')!
    .models.find((item) => item.id === modelId)!
  expect(model.reasoningLevels).not.toContain('off')
  const overrides: AgentConfiguredModel[][] = [
    [],
    [{ ...model, reasoningLevels: ['off', ...model.reasoningLevels] }],
    [{ ...model, reasoningLevels: ['off'] }],
  ]
  for (const models of overrides) {
    const settings = structuredClone(view.settings)
    settings.providers.push({
      id: 'native',
      name: 'Native',
      template: 'openai',
      baseUrl: 'https://native.example',
      secretRef: 'AGENT_PROVIDER_TEST_API_KEY',
      models,
    })
    settings.profiles.fast = { providerId: 'native', modelId, reasoning: 'off' }
    const response = await request('PUT', { revision: 0, settings })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('不支持所选推理强度') })
  }
  expect((await initial()).revision).toBe(0)
  expect(await db.select().from(schema.operator_audits)).toHaveLength(0)
})

it.each(['minimal', 'max'] as const)('rejects a builtin null %s mapping even when the override declares it', async (effort) => {
  const view = await initial()
  const model = view.templates
    .find((item) => item.id === 'openai')!
    .models.find((item) => item.id === 'gpt-5.1')!
  expect(model.reasoningLevels).not.toContain(effort)
  view.settings.providers.push({
    id: 'native',
    name: 'Native',
    template: 'openai',
    baseUrl: 'https://native.example',
    secretRef: 'AGENT_PROVIDER_TEST_API_KEY',
    models: [{ ...model, reasoningLevels: [...MODEL_REASONING_LEVELS] }],
  })
  view.settings.profiles.fast = { providerId: 'native', modelId: model.id, reasoning: effort }
  const response = await request('PUT', { revision: 0, settings: view.settings })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: expect.stringContaining('不支持所选推理强度') })
  expect((await initial()).revision).toBe(0)
  expect(await db.select().from(schema.operator_audits)).toHaveLength(0)
})

it.each([
  ['huggingface', 'MiniMaxAI/MiniMax-M3', 'off', undefined, false],
  ['huggingface', 'MiniMaxAI/MiniMax-M3', 'off', undefined, true],
  ['huggingface', 'MiniMaxAI/MiniMax-M3', 'off', undefined, 'off-only'],
  ['groq', 'qwen/qwen3.6-27b', 'off', 'none', 'off-only'],
  ['groq', 'qwen/qwen3.6-27b', 'high', 'default', false],
  ['groq', 'qwen/qwen3.6-27b', 'high', 'default', true],
] as const)('preserves builtin %s model %s effort %s as %s with override %s', async (template, modelId, effort, wireEffort, override) => {
  const view = await initial()
  const model = view.templates
    .find((item) => item.id === template)!
    .models.find((item) => item.id === modelId)!
  expect(model).toBeDefined()
  view.settings.providers.push({
    id: 'native',
    name: 'Native',
    template,
    baseUrl: 'https://native.example/v1',
    secretRef: 'AGENT_PROVIDER_TEST_API_KEY',
    models: override ? [{ ...model, reasoningLevels: override === 'off-only' ? ['off'] : model.reasoningLevels }] : [],
  })
  view.settings.profiles.fast = { providerId: 'native', modelId: model.id, reasoning: effort }
  expect((await request('PUT', { revision: 0, settings: view.settings })).status).toBe(200)
  const runtime = await resolveConfiguredAgentRuntime('fast')
  expect(runtime.model.reasoning).toBe(true)
  if (effort === 'off') expect(runtime.model.thinkingLevelMap?.off).toBe(wireEffort)
  let payload: Record<string, unknown> | undefined
  setAgentFetchForTesting(async (_input, init) => {
    payload = JSON.parse(String(init?.body))
    return completionStream('ok')
  })
  const stream = await agentStreamFn('fast', {}, runtime)(
    runtime.model,
    { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] },
    { reasoning: effort === 'off' ? undefined : effort },
  )
  expect((await stream.result()).stopReason).toBe('stop')
  expect(payload?.model).toBe(model.id)
  expect(payload?.reasoning_effort).toBe(wireEffort)
})

it('does not inherit an off prohibition when a builtin model changes API protocol', async () => {
  const view = await initial()
  const model = view.templates
    .find((item) => item.id === 'openai')!
    .models.find((item) => item.id === 'gpt-6-astra')!
  view.settings.providers.push({
    id: 'native',
    name: 'Native',
    template: 'openai',
    baseUrl: 'https://native.example/v1',
    secretRef: 'AGENT_PROVIDER_TEST_API_KEY',
    models: [{ ...model, api: 'openai-completions', reasoningLevels: ['off', 'low'] }],
  })
  view.settings.profiles.fast = { providerId: 'native', modelId: model.id, reasoning: 'off' }
  expect((await request('PUT', { revision: 0, settings: view.settings })).status).toBe(200)
  const runtime = await resolveConfiguredAgentRuntime('fast')
  let payload: Record<string, unknown> | undefined
  setAgentFetchForTesting(async (_input, init) => {
    payload = JSON.parse(String(init?.body))
    return completionStream('ok')
  })
  const stream = await agentStreamFn('fast', {}, runtime)(runtime.model, {
    messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
  })
  expect((await stream.result()).stopReason).toBe('stop')
  expect(payload?.reasoning_effort).toBe('none')
  expect(payload?.reasoning).toBeUndefined()
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

it('runs the saved default Luna off profile without a reasoning-effort 400 or changing its configuration', async () => {
  const view = await initial()
  expect(view.settings.profiles.default).toEqual({
    providerId: 'upstream-gateway',
    modelId: 'gpt-6-luna',
    reasoning: 'off',
  })
  expect((await request('PUT', { revision: 0, settings: view.settings })).status).toBe(200)
  const runtime = await resolveConfiguredAgentRuntime()
  const calls: { body: Record<string, unknown>; authorization: string | null }[] = []
  setAgentFetchForTesting(async (_input, init) => {
    const body: Record<string, unknown> = JSON.parse(String(init?.body))
    calls.push({ body, authorization: new Headers(init?.headers).get('authorization') })
    if (body.reasoning_effort !== 'none')
      return Response.json(
        {
          error: {
            message: "Unsupported value for reasoning_effort: 'off'",
            param: 'reasoning_effort',
            code: 'unsupported_value',
          },
        },
        { status: 400 },
      )
    return completionStream('ok')
  })
  const agent = new Agent({
    initialState: {
      model: runtime.model,
      thinkingLevel: runtime.effort,
      systemPrompt: 'System instructions',
    },
    streamFn: agentStreamFn(undefined, {}, runtime),
  })
  await agent.prompt('hi')
  const message = agent.state.messages.at(-1)
  if (message?.role !== 'assistant') throw new Error('Expected a final assistant message')
  expect(message.stopReason).toBe('stop')
  expect(message.content).toMatchObject([{ type: 'text', text: 'ok' }])
  expect(message.usage).toMatchObject({ input: 12, output: 4 })
  expect(runtime.effort).toBe('off')
  expect(calls).toHaveLength(1)
  expect(calls[0]?.authorization).toBe('Bearer legacy-fixture-key')
  expect(calls[0]?.body.model).toBe('gpt-6-luna')
  expect(calls[0]?.body.reasoning_effort).toBe('none')
  expect(calls[0]?.body.messages).toMatchObject([{ role: 'system' }, { role: 'user' }])
  expect(calls[0]?.body.stream_options).toEqual({ include_usage: true })
  const saved = await initial()
  expect(saved.revision).toBe(1)
  expect(saved.settings).toEqual(view.settings)
  expect(await db.select().from(schema.operator_audits)).toHaveLength(1)
})

it.each(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)('preserves custom completions effort %s', async (effort) => {
  const { settings } = await initial()
  const model = settings.providers[0]!.models.find(
    (item) => item.id === settings.profiles.default.modelId,
  )!
  model.reasoningLevels = [...MODEL_REASONING_LEVELS]
  settings.profiles.default.reasoning = effort
  expect((await request('PUT', { revision: 0, settings })).status).toBe(200)
  const runtime = await resolveConfiguredAgentRuntime()
  expect(runtime.model.reasoning).toBe(true)
  let payload: Record<string, unknown> | undefined
  setAgentFetchForTesting(async (_input, init) => {
    payload = JSON.parse(String(init?.body))
    return completionStream('ok')
  })
  const stream = await agentStreamFn(undefined, {}, runtime)(
    runtime.model,
    { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] },
    { reasoning: runtime.effort === 'off' ? undefined : runtime.effort },
  )
  expect((await stream.result()).stopReason).toBe('stop')
  expect(payload?.reasoning_effort).toBe(effort)
})

it('keeps a custom off-only model non-reasoning without sending reasoning fields', async () => {
  const { settings } = await initial()
  for (const model of settings.providers[0]!.models) model.reasoningLevels = ['off']
  for (const profile of Object.values(settings.profiles)) profile.reasoning = 'off'
  expect((await request('PUT', { revision: 0, settings })).status).toBe(200)
  const runtime = await resolveConfiguredAgentRuntime()
  expect(runtime.model.reasoning).toBe(false)
  let payload: Record<string, unknown> | undefined
  setAgentFetchForTesting(async (_input, init) => {
    payload = JSON.parse(String(init?.body))
    return completionStream('ok')
  })
  const stream = await agentStreamFn(undefined, {}, runtime)(runtime.model, {
    messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
  })
  expect((await stream.result()).stopReason).toBe('stop')
  expect(payload?.reasoning_effort).toBeUndefined()
  expect(payload?.reasoning).toBeUndefined()
  expect(payload?.thinking).toBeUndefined()
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

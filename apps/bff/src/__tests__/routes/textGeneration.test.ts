import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { Elysia } from 'elysia'
import { _setPrivateBffOverlayForTesting } from '../../lib/private-overlay'
import { completionStream } from '../helpers/agentStubs'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'

process.env.DATABASE_URL = await resetTestDatabase('canvas_text_generation')
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-billing-operator-config.json')
const billing = installRecordingTaskHooks()
// These modules bind the database/operator singletons on import, after this suite's isolated setup.
const { textGenerationRoutes } = await import('../../routes/textGeneration')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { agentModelSettingsView, saveAgentModelSettings } = await import(
  '../../lib/agent/model-settings-store'
)
const { _setSafeFetchForTesting } = await import('../../lib/safeFetch')
const app = new Elysia().use(textGenerationRoutes)
let cookie = ''
let calls: Record<string, unknown>[] = []
const input = {
  deviceId: 'canvas-text-device',
  model: 'upstream-gateway::fixture-agent-model',
  instruction: '扩写开场',
  currentText: '山海学徒',
  references: [{ id: 'source-text', kind: 'text', label: '人物', text: '主角名叫青禾。' }],
}

async function submit(body = input, authenticated = true) {
  return app.handle(
    new Request('http://localhost/api/canvas/text', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authenticated ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(async () => {
  billing.reset()
  billing.pricing = { outputPriceRatio: 2, outputReserveTokens: 2000 }
  calls = []
  await db.delete(schema.agent_model_settings)
  await db.delete(schema.tasks)
  await db.delete(schema.user_sessions)
  await db.delete(schema.users)
  await db.insert(schema.users).values({
    id: 'text-user',
    username: 'text.user',
    password_hash: 'hash',
    status: 'active',
    created_at: Date.now(),
    updated_at: Date.now(),
  })
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('text-user', tx))}`
  setAgentFetchForTesting(async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)))
    expect(billing.reservations).toHaveLength(1)
    return completionStream('青禾推开山门，云海中传来钟声。')
  })
})

afterEach(() => {
  setAgentFetchForTesting()
  _setSafeFetchForTesting()
})
afterAll(async () => {
  _setPrivateBffOverlayForTesting()
  await close()
})

it('generates with the selected chat model, full source text and one billed task', async () => {
  const response = await submit()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ text: '青禾推开山门，云海中传来钟声。' })
  expect(calls[0]?.model).toBe('fixture-agent-model')
  expect(JSON.stringify(calls[0]?.messages)).toContain('主角名叫青禾。')
  expect(billing.reservations).toHaveLength(1)
  expect(billing.settlements).toMatchObject([{ outcome: 'completed', upstreamInvocationCount: 1 }])
  const [task] = await db.select().from(schema.tasks)
  expect(task).toMatchObject({
    kind: 'chat',
    status: 'completed',
    agent_conversation_id: null,
    agent_turn_id: null,
  })
})

it('rejects unauthenticated and unlisted models before charging or dispatching', async () => {
  expect((await submit(input, false)).status).toBe(401)
  const response = await submit({ ...input, model: 'arbitrary-expensive-model' })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'text_model_unavailable' })
  expect(calls).toEqual([])
  expect(billing.reservations).toEqual([])
})

it('does not dispatch or leave a task when the balance cannot cover generation', async () => {
  billing.answer = { kind: 'insufficient_credits', required: 10, available: 0 }
  const response = await submit()
  expect(response.status).toBe(402)
  expect(await response.json()).toEqual({
    error: 'insufficient_credits',
    required: 10,
    available: 0,
  })
  expect(calls).toEqual([])
  expect(await db.select().from(schema.tasks)).toEqual([])
  expect(billing.settlements).toEqual([])
})

it('releases the reservation on an upstream failure without returning generated text', async () => {
  setAgentFetchForTesting(async () => new Response('upstream denied', { status: 401 }))
  const response = await submit()
  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({ error: 'text_generation_failed' })
  expect(billing.settlements).toMatchObject([{ outcome: 'failed', upstreamInvocationCount: 1 }])
  const [task] = await db.select().from(schema.tasks)
  expect(task?.status).toBe('failed')
})

it('lists and dispatches inherited provider models without requiring custom overrides', async () => {
  _setSafeFetchForTesting({ resolve: async () => [{ address: '8.8.8.8', family: 4 }] })
  const view = await agentModelSettingsView()
  const model = view.templates
    .find((item) => item.id === 'openai')!
    .models.find((item) => item.api === 'openai-responses' && item.imageInput)!
  const settings = {
    ...view.settings,
    providers: [
      ...view.settings.providers,
      {
        id: 'native',
        name: 'Native',
        template: 'openai',
        baseUrl: 'https://native.example',
        secretRef: 'UPSTREAM_API_KEY',
        models: [],
      },
    ],
  }
  await saveAgentModelSettings({ revision: view.revision, settings }, 'test-operator')
  const response = await app.handle(
    new Request('http://localhost/api/canvas/text/models', { headers: { cookie } }),
  )
  const directory = (await response.json()) as { models: { id: string }[] }
  expect(directory.models.some((item) => item.id === `native::${model.id}`)).toBe(true)
  setAgentFetchForTesting(async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)))
    return Response.json({ error: { message: 'fixture rejection' } }, { status: 400 })
  })
  const generated = await submit({ ...input, model: `native::${model.id}` })
  expect(generated.status).toBe(502)
  expect(calls[0]?.model).toBe(model.id)
  expect(billing.settlements).toMatchObject([{ outcome: 'failed', upstreamInvocationCount: 1 }])
})

it('rejects missing pricing without an upstream call or leftover task', async () => {
  billing.answer = { kind: 'price_unavailable', model: 'fixture-agent-model' }
  const response = await submit()
  expect(response.status).toBe(422)
  expect(await response.json()).toEqual({
    error: 'model_price_unavailable',
    model: 'fixture-agent-model',
  })
  expect(calls).toEqual([])
  expect(await db.select().from(schema.tasks)).toEqual([])
})

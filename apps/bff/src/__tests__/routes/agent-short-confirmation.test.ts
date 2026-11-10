import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { type AgentTurnEvent } from '@image-playground/shared'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  completionStream,
  parseFrames,
  recordingAgentFetch,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_short_confirmation')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-operator-config.json')

const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { close: closeDb, db, schema } = await import('../../db/client')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')

await silenceChatUpstream()

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const OWNER = 'confirm-guard-owner'
const estimate = {
  status: 'available' as const,
  estimatedCredits: 0,
  estimatedChargeCredits: 0,
  snapshots: [],
}

async function post(path: string, body: unknown) {
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, json: await response.json() }
}

async function startConversation(): Promise<string> {
  const { status, json } = await post('/api/agent/conversations', { deviceId: DEVICE })
  expect(status).toBe(200)
  return (json as { conversation: { id: string } }).conversation.id
}

async function runTurn(conversationId: string, text: string) {
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE, text }),
    }),
  )
  return { response, frames: parseFrames(await response.text()) }
}

function types(frames: { event: AgentTurnEvent }[]): string[] {
  return frames.map((frame) => frame.event.type)
}

async function ensureOwner() {
  await db
    .insert(schema.users)
    .values({
      id: OWNER,
      username: OWNER,
      password_hash: 'fixture',
      status: 'active',
      created_at: Date.now(),
      updated_at: Date.now(),
    })
    .onConflictDoNothing()
}

async function insertCompletedBatch(conversationId: string, id = '5c9a2650') {
  await ensureOwner()
  await db.insert(schema.agent_batches).values({
    id,
    user_id: OWNER,
    conversation_id: conversationId,
    origin_turn_id: 'origin',
    tool_call_id: id,
    experience: 'chat',
    status: 'closed',
    current_version: 1,
    confirmed_version: 1,
    created_at: Date.now(),
    updated_at: Date.now(),
  })
  await db.insert(schema.agent_batch_plans).values({
    batch_id: id,
    version: 1,
    title: '挂墙台盆六角度',
    rule: 'rule',
    digest: 'a'.repeat(64),
    item_count: 1,
    estimate_snapshot: { analysis: estimate, generation: estimate },
    created_at: Date.now(),
  })
  const taskId = `${id}-task-0`
  await db.insert(schema.agent_batch_items).values({
    batch_id: id,
    version: 1,
    key: 'item-0',
    ordinal: 0,
    kind: 'generation',
    inputs: [],
    prompt: 'prompt',
    params: { model: 'fixture', provider: 'openai-compat' },
    dependencies: [],
  })
  await db.insert(schema.tasks).values({
    id: taskId,
    user_id: OWNER,
    provider: 'openai-compat',
    model: 'fixture',
    status: 'completed',
    request_payload: { device_id: DEVICE, prompt: 'prompt', n: 1 },
    submitted_at: Date.now(),
  })
  await db.insert(schema.agent_batch_attempts).values({
    batch_id: id,
    version: 1,
    item_key: 'item-0',
    attempt: 1,
    task_id: taskId,
    reserved_credits: 100,
    submitted_at: Date.now(),
  })
  return taskId
}

async function insertPendingDraft(conversationId: string) {
  await db.insert(schema.agent_generation_drafts).values({
    id: 'draft-pending',
    conversation_id: conversationId,
    turn_id: 'turn-draft',
    tool_call_id: 'call-draft',
    tool_name: 'editImage',
    media: 'image',
    provider: 'openai-compat',
    model: 'fixture',
    prompt: '浅灰绿色浴缸',
    request: { prompt: '浅灰绿色浴缸', device_id: DEVICE, n: 1 },
    submission: { review: false },
    created_at: Date.now(),
  })
}

function hostileFetch(calls: AgentCall[]) {
  return recordingAgentFetch(calls, () =>
    toolCallCompletion({
      id: 'should-not-run',
      name: 'generateImage',
      args: { prompt: '重复出图' },
    }),
  )
}

beforeEach(async () => {
  setObjectStoreForTesting(new InMemoryObjectStore())
  await db.delete(schema.agent_conversations)
  await db.delete(schema.agent_batch_attempts)
  await db.delete(schema.agent_generation_drafts)
  await db.delete(schema.agent_batches)
  await db.delete(schema.tasks)
})

afterEach(() => {
  setAgentFetchForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  await closeDb()
})

it('does not call the model or any generation tool when the user confirms a finished batch', async () => {
  const calls: AgentCall[] = []
  setAgentFetchForTesting(hostileFetch(calls))
  const conversationId = await startConversation()
  const taskId = await insertCompletedBatch(conversationId)
  const { frames } = await runTurn(conversationId, '确认，执行生成')
  expect(calls).toHaveLength(0)
  expect(types(frames)).not.toContain('toolStart')
  expect(frames.at(-1)?.event).toMatchObject({
    type: 'turnEnd',
    stopReason: 'completed',
    usage: { inputTokens: 0, outputTokens: 0 },
  })
  const text = frames
    .map((frame) => frame.event)
    .filter((event) => event.type === 'textDelta')
    .map((event) => event.delta)
    .join('')
  expect(text).toContain('这批已经出完了')
  expect(text).toContain('5c9a2650')
  expect(text).toContain(taskId)
})

it('does not submit generation when the user only confirms pending cards', async () => {
  const calls: AgentCall[] = []
  setAgentFetchForTesting(hostileFetch(calls))
  const conversationId = await startConversation()
  await insertPendingDraft(conversationId)
  const { frames } = await runTurn(conversationId, '确认')
  expect(calls).toHaveLength(0)
  expect(types(frames)).not.toContain('toolStart')
  const text = frames
    .map((frame) => frame.event)
    .filter((event) => event.type === 'textDelta')
    .map((event) => event.delta)
    .join('')
  expect(text).toContain('请在卡片上点确认')
  expect(frames.at(-1)?.event).toMatchObject({
    type: 'turnEnd',
    stopReason: 'completed',
    usage: { inputTokens: 0, outputTokens: 0 },
  })
})

it('starts a normal turn when the user asks for another version', async () => {
  const calls: AgentCall[] = []
  setAgentFetchForTesting(recordingAgentFetch(calls, () => completionStream('好，再来一版')))
  const conversationId = await startConversation()
  await insertCompletedBatch(conversationId)
  const { frames } = await runTurn(conversationId, '可以再来一版')
  expect(calls).toHaveLength(1)
  expect(frames.at(-1)?.event).toMatchObject({
    type: 'turnEnd',
    stopReason: 'completed',
  })
  const text = frames
    .map((frame) => frame.event)
    .filter((event) => event.type === 'textDelta')
    .map((event) => event.delta)
    .join('')
  expect(text).toContain('好，再来一版')
})

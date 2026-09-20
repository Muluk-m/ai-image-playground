import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  type AgentConversationSnapshot,
  type AgentToolResultBlock,
  DEVICE_ID_HEADER,
} from '@image-playground/shared'
import { and, eq, ne } from 'drizzle-orm'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  completionStream,
  confirmPendingDrafts,
  scriptedAgentFetch,
  TEST_IMAGE_CHANNEL,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'
import { waitFor } from '../helpers/upstreamStubs'

process.env.DATABASE_URL = await resetTestDatabase('agent_wake_credits_a615')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-billing-operator-config.json')

const billing = installRecordingTaskHooks()

const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { _setPrivateBffOverlayForTesting } = await import('../../lib/private-overlay')
const { close: closeDb, db, schema } = await import('../../db/client')
const { finishTask } = await import('../../db/task-transitions')
const { pickUpStrandedInboxes } = await import('../../lib/agent/inbox-pickup')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const CHAT_MODEL = 'fixture-agent-model'
const USER_ID = 'agent-wake-credits-user'
let sessionToken = ''

function request(path: string, init: { method?: string; body?: unknown } = {}) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        [DEVICE_ID_HEADER]: DEVICE,
        cookie: `${USER_SESSION_COOKIE}=${sessionToken}`,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  )
}

async function startConversation(): Promise<string> {
  const response = await request('/api/agent/conversations', {
    method: 'POST',
    body: { deviceId: DEVICE },
  })
  return ((await response.json()) as { conversation: { id: string } }).conversation.id
}

async function leased(conversationId: string): Promise<boolean> {
  const [row] = await db
    .select({ state: schema.agent_executions.state })
    .from(schema.agent_executions)
    .where(eq(schema.agent_executions.conversation_id, conversationId))
  return row?.state === 'running'
}

async function runTurn(conversationId: string, text: string) {
  const response = await request(`/api/agent/conversations/${conversationId}/turns`, {
    method: 'POST',
    body: { deviceId: DEVICE, text },
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`turn returned ${response.status}: ${body}`)
  await waitFor(async () => !(await leased(conversationId)), 3_000)
}

/** 用户在卡上按下确认：拟稿之后任务才建出来，预扣也要到这一步才发生。 */
function confirmDrafts(conversationId: string) {
  return confirmPendingDrafts(app, conversationId, {
    deviceId: DEVICE,
    cookie: `${USER_SESSION_COOKIE}=${sessionToken}`,
  })
}

/** 这个会话里工具交出去的那条生成任务；对话轮自己那条 chat 任务不在此列。 */
async function generationTask(conversationId: string) {
  const [row] = await db
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.agent_conversation_id, conversationId),
        ne(schema.tasks.model, CHAT_MODEL),
      ),
    )
  return row
}

async function snapshot(conversationId: string): Promise<AgentConversationSnapshot> {
  return (await (
    await request(`/api/agent/conversations/${conversationId}/messages`)
  ).json()) as AgentConversationSnapshot
}

async function turnCount(conversationId: string): Promise<number> {
  const rows = await db
    .select({ turnId: schema.agent_turns.turn_id })
    .from(schema.agent_turns)
    .where(eq(schema.agent_turns.conversation_id, conversationId))
  return rows.length
}

let calls: AgentCall[]

beforeEach(async () => {
  billing.reset()
  _setChannelsForTesting([TEST_IMAGE_CHANNEL])
  setObjectStoreForTesting(new InMemoryObjectStore())
  await db.delete(schema.tasks)
  await db.delete(schema.agent_conversations)
  await db.delete(schema.agent_executions)
  await db.delete(schema.user_sessions)
  await db.delete(schema.users)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: USER_ID,
    username: 'agent.wake.credits',
    password_hash: 'hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  sessionToken = await db.transaction((tx) => createUserSession(USER_ID, tx))
  calls = []
})

afterEach(() => {
  setAgentFetchForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  _setPrivateBffOverlayForTesting()
  await closeDb()
})

describe('积分不足时不唤醒', () => {
  it('skips the wake, keeps the result, and records why the agent did not look', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion({
            id: 'call-1',
            name: 'generateImage',
            args: { prompt: '一只橘猫' },
          }),
        () => completionStream('不该有这一轮'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    await confirmDrafts(conversationId)
    const task = await generationTask(conversationId)

    // 这一轮之后余额见底：任务失败本该唤醒智能体，但再起一轮的预扣会被拒。
    billing.answer = { kind: 'insufficient_credits', required: 50, available: 3 }
    const now = Date.now()
    await db
      .update(schema.tasks)
      .set({ status: 'in_progress', started_at: now })
      .where(eq(schema.tasks.id, task!.id))
    expect(
      await finishTask(task!.id, {
        status: 'failed',
        completedAt: now,
        errorMessage: '上游超时',
        errorType: 'upstream_timeout',
      }),
    ).toBe(true)

    expect(await pickUpStrandedInboxes()).toBe(0)
    expect(calls).toHaveLength(1)
    expect(await turnCount(conversationId)).toBe(1)
    const [wake] = await db
      .select()
      .from(schema.agent_inbox)
      .where(
        and(
          eq(schema.agent_inbox.conversation_id, conversationId),
          eq(schema.agent_inbox.kind, 'task_result'),
        ),
      )
    expect(wake!.status).toBe('cancelled')

    // 结果卡照常是终局，带着没唤醒的原因：面板据此说明助手没有查看结果。
    const block = (await snapshot(conversationId)).messages
      .flatMap((message) => message.content)
      .find(
        (one): one is AgentToolResultBlock =>
          one.type === 'toolResult' && one.job?.taskId === task!.id,
      )
    expect(block?.status).toBe('failed')
    expect(block?.wakeSkipped).toBe('insufficient_credits')

    // 充值之后也不补唤醒：这一批已经了结，结果在用户下次说话时智能体看得到。
    billing.answer = { kind: 'reserved', credits: 50 }
    expect(await pickUpStrandedInboxes()).toBe(0)
    expect(calls).toHaveLength(1)
  })

  it('lets the user message start without the merged wake when only the merged turn does not fit', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion({
            id: 'call-1',
            name: 'generateImage',
            args: { prompt: '一只橘猫' },
          }),
        () => completionStream('好的，背景换成蓝色'),
        () => completionStream('不该有单独的唤醒轮'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    await confirmDrafts(conversationId)
    const task = await generationTask(conversationId)
    const now = Date.now()
    await db
      .update(schema.tasks)
      .set({ status: 'in_progress', started_at: now })
      .where(eq(schema.tasks.id, task!.id))
    expect(
      await finishTask(task!.id, {
        status: 'failed',
        completedAt: now,
        errorMessage: '上游超时',
        errorType: 'upstream_timeout',
      }),
    ).toBe(true)

    // 余额只够用户这条消息自己：带上唤醒说明的那次预扣被拒，只为这条消息的那次准，唤醒自己那轮也被拒。
    const before = billing.reservations.length
    const answers = [
      { kind: 'insufficient_credits', required: 50, available: 30 },
      { kind: 'reserved', credits: 30 },
      { kind: 'insufficient_credits', required: 30, available: 0 },
    ] as const
    billing.decide = () => answers[billing.reservations.length - before - 1]
    await runTurn(conversationId, '顺便把背景换成蓝色')

    // 用户的话照常起轮，模型收到的只有他的原话，没有并进唤醒说明。
    await waitFor(async () => (await wakeRow(conversationId))?.status === 'cancelled', 3_000)
    expect(calls).toHaveLength(2)
    const asked = JSON.stringify(
      calls[1]!.messages.filter((message) => message.role === 'user').at(-1),
    )
    expect(asked).toContain('顺便把背景换成蓝色')
    expect(asked).not.toContain('先回应用户这条消息')
    expect(await turnCount(conversationId)).toBe(2)

    // 先带说明预扣，被拒后按用户这条消息自己的量再来一次；两次记在同一轮上。
    const [mergedTry, plainTry, wakeTry] = billing.reservations.slice(before)
    expect(mergedTry!.taskId).toBe(plainTry!.taskId)
    expect(mergedTry!.unitMultiplier).toBeGreaterThan(plainTry!.unitMultiplier)
    expect(wakeTry!.taskId).not.toBe(plainTry!.taskId)

    // 唤醒没有被那一轮取走，而是走自己的路，因积分不足被跳过，结果卡记着原因。
    const block = (await snapshot(conversationId)).messages
      .flatMap((message) => message.content)
      .find(
        (one): one is AgentToolResultBlock =>
          one.type === 'toolResult' && one.job?.taskId === task!.id,
      )
    expect(block?.wakeSkipped).toBe('insufficient_credits')
    expect(await pickUpStrandedInboxes()).toBe(0)
    expect(calls).toHaveLength(2)
  })
})

async function wakeRow(conversationId: string) {
  const [row] = await db
    .select()
    .from(schema.agent_inbox)
    .where(
      and(
        eq(schema.agent_inbox.conversation_id, conversationId),
        eq(schema.agent_inbox.kind, 'task_result'),
      ),
    )
  return row
}

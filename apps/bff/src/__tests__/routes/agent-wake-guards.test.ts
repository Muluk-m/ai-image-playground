import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  AGENT_MAX_CONSECUTIVE_WAKES,
  type AgentConversationSnapshot,
  type AgentMessageQueuedBody,
  type AgentToolResultBlock,
  DEVICE_ID_HEADER,
} from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  completionStream,
  confirmPendingDrafts,
  controlledCompletion,
  parseFrames,
  recordingAgentFetch,
  scriptedAgentFetch,
  TEST_IMAGE_CHANNEL,
  type ToolCallSpec,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { waitFor } from '../helpers/upstreamStubs'

process.env.DATABASE_URL = await resetTestDatabase('agent_wake_guards_a615')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-operator-config.json')

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { close: closeDb, db, schema } = await import('../../db/client')
const { workerSettles } = await import('../helpers/taskWorker')
const { pickUpStrandedInboxes } = await import('../../lib/agent/inbox-pickup')
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)

await silenceChatUpstream()
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'

function request(path: string, init: { method?: string; body?: unknown } = {}) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', [DEVICE_ID_HEADER]: DEVICE },
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

function send(conversationId: string, text: string) {
  return request(`/api/agent/conversations/${conversationId}/turns`, {
    method: 'POST',
    body: { deviceId: DEVICE, text },
  })
}

async function runTurn(conversationId: string, text: string) {
  const response = await send(conversationId, text)
  const body = await response.text()
  if (!response.ok) throw new Error(`turn returned ${response.status}: ${body}`)
  await waitFor(async () => !(await leased(conversationId)), 3_000)
  return parseFrames(body)
}

async function leased(conversationId: string): Promise<boolean> {
  const [row] = await db
    .select({ state: schema.agent_executions.state })
    .from(schema.agent_executions)
    .where(eq(schema.agent_executions.conversation_id, conversationId))
  return row?.state === 'running'
}

async function snapshot(conversationId: string): Promise<AgentConversationSnapshot> {
  return (await (
    await request(`/api/agent/conversations/${conversationId}/messages`)
  ).json()) as AgentConversationSnapshot
}

async function turnIds(conversationId: string): Promise<string[]> {
  const rows = await db
    .select({ turnId: schema.agent_turns.turn_id })
    .from(schema.agent_turns)
    .where(eq(schema.agent_turns.conversation_id, conversationId))
  return rows.map((row) => row.turnId)
}

async function waitForTurns(conversationId: string, count: number): Promise<void> {
  await waitFor(async () => (await turnIds(conversationId)).length >= count, 5_000)
  await waitFor(async () => !(await leased(conversationId)), 5_000)
}

async function tasksOf(conversationId: string) {
  return db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.agent_conversation_id, conversationId))
    .orderBy(schema.tasks.submitted_at)
}

async function wakes(conversationId: string) {
  return db
    .select()
    .from(schema.agent_inbox)
    .where(
      and(
        eq(schema.agent_inbox.conversation_id, conversationId),
        eq(schema.agent_inbox.kind, 'task_result'),
      ),
    )
    .orderBy(schema.agent_inbox.seq)
}

/** 测试里的迷你 worker：认领任务再按真实路径推到失败，唤醒判断就在收尾的那个事务里。 */
async function fail(taskId: string) {
  const finished = await workerSettles(taskId, {
    status: 'failed',
    errorMessage: '上游超时',
    errorType: 'upstream_timeout',
  })
  expect(finished).toBe(true)
}

/** 用户在卡上按下确认：拟稿之后任务才建出来，凡是要等任务结束的用例都走一遍它。 */
function confirmDrafts(conversationId: string) {
  return confirmPendingDrafts(app, conversationId, { deviceId: DEVICE })
}

function generate(id: string): ToolCallSpec {
  return { id, name: 'generateImage', args: { prompt: `一只橘猫 ${id}` } }
}

function lastUserInput(call: AgentCall): string {
  return JSON.stringify(call.messages.filter((message) => message.role === 'user').at(-1))
}

function toolBlock(
  snapshotBody: AgentConversationSnapshot,
  taskId: string,
): AgentToolResultBlock | undefined {
  return snapshotBody.messages
    .flatMap((message) => message.content)
    .find(
      (block): block is AgentToolResultBlock =>
        block.type === 'toolResult' && block.job?.taskId === taskId,
    )
}

let calls: AgentCall[]

beforeEach(async () => {
  _setChannelsForTesting([TEST_IMAGE_CHANNEL])
  setObjectStoreForTesting(new InMemoryObjectStore())
  await db.delete(schema.tasks)
  await db.delete(schema.agent_conversations)
  await db.delete(schema.agent_executions)
  calls = []
})

afterEach(() => {
  setAgentFetchForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('唤醒并进排队消息', () => {
  it('folds the wake into the queued message turn instead of waking separately', async () => {
    const reply = controlledCompletion()
    const answers = [
      () => toolCallCompletion(generate('call-1')),
      (signal?: AbortSignal) => reply.responseFor(signal),
      () => completionStream('好的，背景换成蓝色；另外刚才那张没出来'),
      () => completionStream('不该有单独的唤醒轮'),
    ]
    let at = 0
    setAgentFetchForTesting(
      recordingAgentFetch(calls, (signal) => answers[Math.min(at++, answers.length - 1)]!(signal)),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    // 拟稿那一轮早已收尾，任务是用户按下确认之后才交出去的。
    await confirmDrafts(conversationId)
    const [task] = await tasksOf(conversationId)

    // 会话正被另一轮占着时任务失败了，用户又排了一句话。
    const busy = await send(conversationId, '先把刚才那张放大看看')
    // 这一轮卡在上游流上，要到收尾才结束：后台把它的 SSE 读掉，别让响应体没人收。
    const busyBody = busy.text()
    await waitFor(() => calls.length === 2, 3_000)
    await fail(task!.id)
    const queuedResponse = await send(conversationId, '顺便把背景换成蓝色')
    expect(queuedResponse.status).toBe(202)
    const { queued } = (await queuedResponse.json()) as AgentMessageQueuedBody

    reply.push('放大看过了')
    reply.finish()
    await busyBody
    await waitForTurns(conversationId, 3)

    // 那条消息那一轮顺带看了结果：模型收到用户原话，后面跟着任务结果的说明。
    expect(calls).toHaveLength(3)
    const merged = lastUserInput(calls[2]!)
    expect(merged).toContain('顺便把背景换成蓝色')
    expect(merged).toContain('失败（上游超时）')
    expect(merged).toContain('先回应用户这条消息')

    // 唤醒被那一轮取走，不再单独起轮。
    const [wake] = await wakes(conversationId)
    const [message] = await db
      .select()
      .from(schema.agent_inbox)
      .where(eq(schema.agent_inbox.id, queued.id))
    expect(wake!.status).toBe('consumed')
    expect(wake!.consumed_turn_id).toBe(message!.consumed_turn_id)
    expect(await pickUpStrandedInboxes()).toBe(0)
    expect(calls).toHaveLength(3)
    expect(await turnIds(conversationId)).toHaveLength(3)
  })

  it('folds a pending wake into a message sent while the conversation is idle', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion(generate('call-1')),
        () => completionStream('背景换好了；刚才那张没出来'),
        () => completionStream('不该有单独的唤醒轮'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    await confirmDrafts(conversationId)
    const [task] = await tasksOf(conversationId)
    await fail(task!.id)
    // 唤醒已经写进收件箱，还没有谁起轮，用户就说话了。
    expect(await wakes(conversationId)).toHaveLength(1)

    await runTurn(conversationId, '顺便把背景换成蓝色')
    expect(calls).toHaveLength(2)
    const merged = lastUserInput(calls[1]!)
    expect(merged).toContain('顺便把背景换成蓝色')
    expect(merged).toContain('失败（上游超时）')
    const [wake] = await wakes(conversationId)
    expect(wake!.status).toBe('consumed')
    expect(await pickUpStrandedInboxes()).toBe(0)
    expect(calls).toHaveLength(2)
  })
})

describe('连续自动唤醒上限', () => {
  it(`stops after ${AGENT_MAX_CONSECUTIVE_WAKES} wakes in a row and counts again once the user speaks`, async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion(generate('call-1')),
        // 三次唤醒：每次都失败、又自己重拟一张稿。
        () => toolCallCompletion(generate('call-2')),
        () => toolCallCompletion(generate('call-3')),
        () => toolCallCompletion(generate('call-4')),
        // 用户说话之后：新的一轮与它之后的一次唤醒。
        () => toolCallCompletion(generate('call-5')),
        () => completionStream('这张也没出来'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    await confirmDrafts(conversationId)

    for (let wake = 1; wake <= AGENT_MAX_CONSECUTIVE_WAKES; wake += 1) {
      const tasks = await tasksOf(conversationId)
      await fail(tasks.at(-1)!.id)
      expect(await pickUpStrandedInboxes()).toBe(1)
      await waitForTurns(conversationId, 1 + wake)
      // 唤醒轮同样只拟稿：它重提的那一张也要用户确认才交出去。
      expect(await confirmDrafts(conversationId)).toHaveLength(1)
    }
    expect(calls).toHaveLength(4)

    // 第四次：不再唤醒，停下等用户。结果卡上记着原因，面板据此说明。
    const tasks = await tasksOf(conversationId)
    expect(tasks).toHaveLength(4)
    await fail(tasks.at(-1)!.id)
    expect(await pickUpStrandedInboxes()).toBe(0)
    expect(calls).toHaveLength(4)
    expect(await turnIds(conversationId)).toHaveLength(4)
    const skipped = (await wakes(conversationId)).at(-1)!
    expect(skipped.status).toBe('cancelled')
    expect(toolBlock(await snapshot(conversationId), tasks.at(-1)!.id)?.wakeSkipped).toBe(
      'wake_limit',
    )
    expect(toolBlock(await snapshot(conversationId), tasks[0]!.id)?.wakeSkipped).toBeUndefined()

    // 用户说话后重新计数：他这一轮提交的任务失败时照常唤醒。
    await runTurn(conversationId, '再画一次')
    await confirmDrafts(conversationId)
    expect(calls).toHaveLength(5)
    const retried = (await tasksOf(conversationId)).at(-1)!
    await fail(retried.id)
    expect(await pickUpStrandedInboxes()).toBe(1)
    await waitForTurns(conversationId, 6)
    expect(calls).toHaveLength(6)
    expect(lastUserInput(calls[5]!)).toContain('一只橘猫 call-5：失败')
  })
})

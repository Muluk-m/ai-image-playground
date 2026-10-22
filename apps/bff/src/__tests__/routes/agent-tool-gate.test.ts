import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  type AgentConfirmationResponse,
  type AgentConversationSnapshot,
  type AgentMessageView,
  type AgentToolResultBlock,
  DEVICE_ID_HEADER,
} from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  completionStream,
  parseFrames,
  scriptedAgentFetch,
  TEST_IMAGE_CHANNEL,
  type ToolCallSpec,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { waitFor } from '../helpers/upstreamStubs'

process.env.DATABASE_URL = await resetTestDatabase('agent_tool_gate_b112')
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
const { confirmAgentGeneration } = await import('../../lib/agent/confirmations')
const { GATE_VOIDED_MESSAGE } = await import('../../lib/agent/tool-gate-records')
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)

await silenceChatUpstream()
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
/** 用户在参数里关掉了「直接出图」：确认门只在这时开。 */
const GATED = { autoSubmit: false }

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

async function runTurn(conversationId: string, text: string, params?: Record<string, unknown>) {
  const response = await request(`/api/agent/conversations/${conversationId}/turns`, {
    method: 'POST',
    body: { deviceId: DEVICE, text, ...(params ? { params } : {}) },
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`turn returned ${response.status}: ${body}`)
  // 终帧之后这一轮还要放手租约；等它放完，后面的断言才不和收尾抢。
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

/** 等服务端自己起的那一轮（续跑、唤醒）收尾：它的页脚落库、租约放手。 */
async function waitForTurns(conversationId: string, count: number): Promise<void> {
  await waitFor(async () => (await turnIds(conversationId)).length >= count, 5_000)
  await waitFor(async () => !(await leased(conversationId)), 5_000)
}

function tasksOf(conversationId: string) {
  return db
    .select()
    .from(schema.tasks)
    .where(
      and(eq(schema.tasks.agent_conversation_id, conversationId), eq(schema.tasks.kind, 'queue')),
    )
}

function cards(messages: readonly AgentMessageView[]) {
  return messages.flatMap((message) =>
    message.content.flatMap((block) =>
      block.type === 'toolResult' ? [{ messageId: message.id, block }] : [],
    ),
  )
}

async function cardsOf(conversationId: string) {
  return cards((await snapshot(conversationId)).messages)
}

async function confirm(
  conversationId: string,
  card: { messageId: string; block: AgentToolResultBlock },
  prompt = card.block.prompt ?? '',
) {
  const response = await request(`/api/agent/conversations/${conversationId}/confirmations`, {
    method: 'POST',
    body: { deviceId: DEVICE, messageId: card.messageId, prompt },
  })
  return { status: response.status, json: (await response.json()) as AgentConfirmationResponse }
}

function generate(id: string, prompt = `一只橘猫 ${id}`): ToolCallSpec {
  return { id, name: 'generateImage', args: { prompt } }
}

/** OpenAI 兼容格式里那条消息的纯文本。 */
function textOf(message: { content: unknown }): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
}

let calls: AgentCall[]

beforeEach(async () => {
  _setChannelsForTesting([TEST_IMAGE_CHANNEL])
  setObjectStoreForTesting(new InMemoryObjectStore())
  calls = []
})

afterEach(() => {
  setAgentFetchForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('确认门', () => {
  it('关掉直接出图时：拦下生成，智能体拿到的是已提交的回执；确认后同一件事接着往下走', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion(generate('call-1', '一只橘猫')),
        () => completionStream('已经开始画了，出来之后我再看看构图。'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫', GATED)

    // 拦下的这次没花钱：没有任务，卡停在待确认并标了确认门。这一轮停在这次调用之后。
    expect(await tasksOf(conversationId)).toEqual([])
    expect(calls).toHaveLength(1)
    const [pending] = await cardsOf(conversationId)
    expect(pending!.block).toMatchObject({
      status: 'awaiting_confirmation',
      gated: true,
      toolName: 'generateImage',
    })

    const { status, json } = await confirm(conversationId, pending!, '一只戴围巾的橘猫')
    expect(status).toBe(200)
    expect(json.continued).toBe(true)
    await waitForTurns(conversationId, 2)

    // 确认交的是用户改过的那一句。
    const tasks = await tasksOf(conversationId)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.request_payload.prompt).toContain('一只戴围巾的橘猫')

    // 续跑：没有新的用户话，历史末尾就是那次调用与它的回执——智能体看来调用已经提交，
    // 没有「用户确认了」之类的回执文案。
    expect(calls).toHaveLength(2)
    const sent = calls[1]!.messages
    const last = sent.at(-1)!
    expect(last.role).toBe('tool')
    expect(textOf(last)).toContain('已按用户要求提交')
    expect(textOf(last)).toContain('一只戴围巾的橘猫')
    expect(textOf(last)).not.toContain('确认')
    // 回执就是拦下那一刻交给模型的那一句（版本数、尺寸都在），只在末尾补上确认的提示词。
    expect(pending!.block.gateReceipt).toContain('1 张图')
    expect(textOf(last)).toContain(pending!.block.gateReceipt!)
    const assistant = sent.at(-2) as { role: string; tool_calls?: { id: string }[] }
    expect(assistant.role).toBe('assistant')
    expect(assistant.tool_calls?.map((call) => call.id)).toEqual(['call-1'])
    expect(sent.filter((message) => message.role === 'user')).toHaveLength(1)

    // 界面上：只有一条用户消息，续跑的回复接在被拦下的那段回复后面，卡已提交。
    const { messages } = await snapshot(conversationId)
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(JSON.stringify(messages.at(-1))).toContain('已经开始画了')
    const [card] = cards(messages)
    expect(card!.block).toMatchObject({ status: 'submitted', gated: true })
  })

  it('同一轮拦下两张：确认第一张不续跑，两张都确认了才接着走，而且只续一次', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion(generate('call-1'), generate('call-2')),
        () => completionStream('两张都在画了。'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画两只不同的橘猫', GATED)
    const [first, second] = await cardsOf(conversationId)
    expect([first!.block.gated, second!.block.gated]).toEqual([true, true])

    expect((await confirm(conversationId, first!)).json.continued).toBeUndefined()
    // 还有一张没拿主意：不起轮。
    expect(await pickUpStrandedInboxes()).toBe(0)
    expect((await confirm(conversationId, second!)).json.continued).toBe(true)
    await waitForTurns(conversationId, 2)
    // 再点一次确认是重放：交回同一张卡，不再排第二次续跑。
    const replayed = await confirm(conversationId, second!)
    expect(replayed.status).toBe(200)
    expect(replayed.json.continued).toBeUndefined()
    expect(await pickUpStrandedInboxes()).toBe(0)

    expect(await turnIds(conversationId)).toHaveLength(2)
    expect(calls).toHaveLength(2)
    const sent = calls[1]!.messages
    expect(sent.slice(-2).map((message) => message.role)).toEqual(['tool', 'tool'])
    expect(await tasksOf(conversationId)).toHaveLength(2)
  })

  it('已提交的确认门卡再点确认：续跑还没被取走就让调用方再开一次轮，跑过之后不再碰', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion(generate('call-1')),
        () => completionStream('已经开始画了。'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫', GATED)
    const [pending] = await cardsOf(conversationId)

    // 直接走确认逻辑、不经路由：确认已提交、续跑已排上，但开轮之前进程就没了。
    const first = await confirmAgentGeneration({
      conversationId,
      owner: { kind: 'device', deviceId: DEVICE },
      messageId: pending!.messageId,
      prompt: pending!.block.prompt ?? '',
      deviceId: DEVICE,
      userId: null,
    })
    expect(first).toMatchObject({ kind: 'created', continued: true })
    expect(await turnIds(conversationId)).toHaveLength(1)

    // 用户再点一次（或换台设备）：卡已提交，交回同一张；续跑还在等，路由据此去开轮。
    const replayed = await confirm(conversationId, pending!)
    expect(replayed.status).toBe(200)
    expect(replayed.json.continued).toBe(true)
    expect(replayed.json.message.content).toContainEqual(
      expect.objectContaining({ status: 'submitted', gated: true }),
    )
    await waitForTurns(conversationId, 2)
    expect(calls).toHaveLength(2)
    expect(await tasksOf(conversationId)).toHaveLength(1)

    // 续跑跑过之后再重放：不再排，也不再开轮。
    expect((await confirm(conversationId, pending!)).json.continued).toBeUndefined()
    expect(await pickUpStrandedInboxes()).toBe(0)
    expect(await turnIds(conversationId)).toHaveLength(2)
    expect(calls).toHaveLength(2)
  })

  it('续跑已被取走、那一轮还没跑完时重放确认：仍告诉调用方去跟进；跑完之后不再说', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [() => toolCallCompletion(generate('call-1'))]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫', GATED)
    const [pending] = await cardsOf(conversationId)
    const input = {
      conversationId,
      owner: { kind: 'device' as const, deviceId: DEVICE },
      messageId: pending!.messageId,
      prompt: pending!.block.prompt ?? '',
      deviceId: DEVICE,
      userId: null,
    }
    expect(await confirmAgentGeneration(input)).toMatchObject({ kind: 'created', continued: true })
    // 假装续跑已被另一个实例取走、还没跑完（取件已提交，页脚还没落）。
    const continuationTurn = 'continuation-turn'
    await db
      .update(schema.agent_inbox)
      .set({ status: 'consumed', consumed_turn_id: continuationTurn })
      .where(eq(schema.agent_inbox.conversation_id, conversationId))
    // 第一次确认的响应丢了，客户端重试：交回同一张卡，并让它跟进那一轮。
    expect(await confirmAgentGeneration(input)).toMatchObject({ kind: 'replayed', continued: true })

    // 那一轮落了页脚：跑完了，重放不再让客户端跟进。
    await db.insert(schema.agent_turns).values({
      conversation_id: conversationId,
      turn_id: continuationTurn,
      duration_ms: 1,
      stop_reason: 'completed',
      created_at: Date.now(),
    })
    const settled = await confirmAgentGeneration(input)
    expect(settled.kind).toBe('replayed')
    expect('continued' in settled ? settled.continued : undefined).toBeUndefined()
    expect(await tasksOf(conversationId)).toHaveLength(1)
  })

  it('没确认就发了新消息：卡作废、不提交，再点确认也交不出去', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion(generate('call-1')),
        () => completionStream('好的，那换成柴犬。'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫', GATED)
    const [pending] = await cardsOf(conversationId)

    await runTurn(conversationId, '算了，换成柴犬吧', GATED)

    const [voided] = await cardsOf(conversationId)
    expect(voided!.block).toMatchObject({
      status: 'failed',
      errorCode: 'cancelled',
      gated: true,
      message: GATE_VOIDED_MESSAGE,
    })
    // 新的一轮里，智能体看得到那次调用没交出去。
    expect(JSON.stringify(calls[1]!.messages)).toContain(GATE_VOIDED_MESSAGE)
    const { status } = await confirm(conversationId, pending!)
    expect(status).toBe(422)
    expect(await tasksOf(conversationId)).toEqual([])
  })

  it('没带偏好的请求不开门：仍是原来的拟稿收尾，确认后不续跑', async () => {
    setAgentFetchForTesting(scriptedAgentFetch(calls, [() => toolCallCompletion(generate('c'))]))
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    const [pending] = await cardsOf(conversationId)
    expect(pending!.block.status).toBe('awaiting_confirmation')
    expect(pending!.block.gated).toBeUndefined()

    const { json } = await confirm(conversationId, pending!)
    expect(json.continued).toBeUndefined()
    expect(await pickUpStrandedInboxes()).toBe(0)
    expect(await turnIds(conversationId)).toHaveLength(1)
  })

  it('有一张卡还等着确认时，别的任务失败了也先不唤醒；续跑之后再唤醒', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion(generate('call-1', '第一只橘猫')),
        () => completionStream('第一张在画了。'),
        () => toolCallCompletion(generate('call-2', '第二只橘猫')),
        () => completionStream('第二张也在画了。'),
        () => completionStream('第一张没出来，我换个说法再试。'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫', GATED)
    await confirm(conversationId, (await cardsOf(conversationId))[0]!)
    await waitForTurns(conversationId, 2)
    await runTurn(conversationId, '再画一只', GATED)
    const [task] = await tasksOf(conversationId)

    expect(
      await workerSettles(task!.id, {
        status: 'failed',
        completedAt: Date.now(),
        errorMessage: '上游超时',
        errorType: 'upstream_timeout',
      }),
    ).toBe(true)
    const [wake] = await db
      .select()
      .from(schema.agent_inbox)
      .where(
        and(
          eq(schema.agent_inbox.conversation_id, conversationId),
          eq(schema.agent_inbox.kind, 'task_result'),
        ),
      )
    expect(wake?.status).toBe('pending')
    // 第二张还没拿主意：智能体以为它已经提交了，这时唤醒会把它当成在跑。
    expect(await pickUpStrandedInboxes()).toBe(0)

    const second = (await cardsOf(conversationId)).find(
      (card) => card.block.status === 'awaiting_confirmation',
    )
    expect((await confirm(conversationId, second!)).json.continued).toBe(true)
    // 续跑那一轮收尾时收件箱接着取下一件：被扣住的唤醒这时才起轮。
    await waitForTurns(conversationId, 5)
    expect(calls).toHaveLength(5)
    expect(JSON.stringify((await snapshot(conversationId)).messages.at(-1))).toContain(
      '第一张没出来',
    )
  })
})

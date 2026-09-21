import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  type AgentConversationView,
  type AgentToolResultBlock,
  DEVICE_ID_HEADER,
} from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  completionStream,
  parseFrames,
  scriptedAgentFetch,
} from '../helpers/agentStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { waitFor } from '../helpers/upstreamStubs'

/**
 * 有界历史查询的行为面。窗口本身钉在 `lib/agent/conversations` 那一层；这里只断言压缩过的
 * 长会话在 HTTP 这一头看得见的三件事——折进摘要的原文不再出站、会话不被当成新会话、
 * 唤醒点名的结果卡比窗口更老时照样找得到。
 */

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_bounded_history')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
// 默认窗口装得下这里的任何一段历史：出站那一份短下去，只可能是因为没读那么多，不是被压缩裁的。
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-operator-config.json')

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { setChatFetchForTesting, setChatRetryBackoffForTesting } = await import(
  '../../lib/chatCompletion'
)
// 摘要与自动命名都走 chatCompletion：这里一律让它 502，真退避只会拖慢测试。
setChatRetryBackoffForTesting(0)
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { appendAgentMessage, saveAgentCompaction, setAgentConversationTitle } = await import(
  '../../lib/agent/conversations'
)
const { enqueueAgentWake } = await import('../../lib/agent/inbox')
const { pickUpStrandedInboxes } = await import('../../lib/agent/inbox-pickup')
const { close: closeDb, db, schema } = await import('../../db/client')
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const OWNER = { kind: 'device', deviceId: DEVICE } as const
/** 提交后台任务的那一轮；它会被折进摘要，落在历史窗口之外。 */
const SUBMIT_TURN = 'turn-submitted'

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

async function runTurn(conversationId: string, text: string) {
  const response = await request(`/api/agent/conversations/${conversationId}/turns`, {
    method: 'POST',
    body: { deviceId: DEVICE, text },
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

/** 每条历史的记号。`H` 与 `Z` 夹着序号，`记号H1Z` 就不会是 `记号H12Z` 的子串。 */
function mark(at: number): string {
  return `记号H${at}Z`
}

async function seedHistory(conversationId: string, count: number): Promise<string[]> {
  const ids: string[] = []
  for (let at = 0; at < count; at += 1) {
    const message = await appendAgentMessage(db, {
      conversationId,
      turnId: `seed-${at}`,
      role: at % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `第 ${at} 段历史，${mark(at)}。` }],
    })
    ids.push(message.id)
  }
  return ids
}

/** 一份有效的压缩记录：到 `lastMessageId` 为止的 `coveredCount` 条都已经折进摘要。 */
async function fold(
  conversationId: string,
  anchor: { lastMessageId: string; coveredCount: number },
): Promise<void> {
  await saveAgentCompaction(conversationId, {
    summary: {
      completed: '出过几张橘猫图',
      inProgress: '在调背景',
      decisions: '主体不换',
      artifacts: '橘猫三视图',
    },
    anchor,
    verbatim: { omittedCount: 2, omittedChars: 24, kept: ['把这只橘猫画得更亮一点'] },
    foldCount: 1,
    failureCount: 0,
    openedAt: null,
  })
}

async function titleOf(conversationId: string): Promise<string> {
  const body = (await (await request('/api/agent/conversations')).json()) as {
    conversations: AgentConversationView[]
  }
  return body.conversations.find((conversation) => conversation.id === conversationId)!.title
}

/** 提交那一轮留下的结果卡，已经是终局（任务行早已清掉，不靠结算补）。 */
function failedCard(taskId: string): AgentToolResultBlock {
  return {
    type: 'toolResult',
    toolCallId: 'call-old',
    toolName: 'generateImage',
    status: 'failed',
    title: '拍立得版橘猫',
    prompt: '把这只橘猫画成拍立得',
    message: '上游超时',
    errorCode: 'timeout',
    job: { taskId, media: 'image' },
  }
}

beforeEach(async () => {
  setObjectStoreForTesting(new InMemoryObjectStore())
  setChatFetchForTesting(async () => new Response('nope', { status: 502 }))
  await db.delete(schema.agent_conversations)
})

afterEach(() => {
  setAgentFetchForTesting()
  setChatFetchForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  await closeDb()
})

it('折进摘要的那几条不再出现在发出去的那一份里', async () => {
  const calls: AgentCall[] = []
  setAgentFetchForTesting(scriptedAgentFetch(calls, [() => completionStream('好的')]))
  const conversationId = await startConversation()
  const ids = await seedHistory(conversationId, 20)
  await fold(conversationId, { lastMessageId: ids[11]!, coveredCount: 12 })

  await runTurn(conversationId, '继续')

  expect(calls).toHaveLength(1)
  const sent = JSON.stringify(calls[0]!.messages)
  // 这一段窗口装得下，没有任何东西会在出站前被裁：原文不在，就是根本没读它们。
  expect(sent).not.toContain(mark(0))
  expect(sent).not.toContain(mark(11))
  expect(sent).toContain(mark(12))
  expect(sent).toContain(mark(19))
})

it('压缩过的会话不被当成头一轮，用户看到的标题不被冲掉', async () => {
  setAgentFetchForTesting(scriptedAgentFetch([], [() => completionStream('好的')]))
  const conversationId = await startConversation()
  const ids = await seedHistory(conversationId, 6)
  // 整段历史都折进了摘要：窗口是空的，但这显然不是一个新会话。
  await fold(conversationId, { lastMessageId: ids[5]!, coveredCount: 6 })
  await setAgentConversationTitle(db, conversationId, OWNER, '橘猫封面专用')

  await runTurn(conversationId, '继续')

  expect(await titleOf(conversationId)).toBe('橘猫封面专用')
})

it('唤醒点名的结果卡比历史窗口更老时照样起轮', async () => {
  const calls: AgentCall[] = []
  setAgentFetchForTesting(
    scriptedAgentFetch(calls, [() => completionStream('这张没成，换个说法再试？')]),
  )
  const conversationId = await startConversation()
  const taskId = 'task-bounded-history'
  await appendAgentMessage(db, {
    conversationId,
    turnId: SUBMIT_TURN,
    role: 'user',
    content: [{ type: 'text', text: '把这只橘猫画成拍立得' }],
  })
  const card = await appendAgentMessage(db, {
    conversationId,
    turnId: SUBMIT_TURN,
    role: 'assistant',
    content: [failedCard(taskId)],
  })
  // 提交那一轮连人带卡都折进了摘要，之后又聊了八条：结果卡落在历史窗口之外。
  await seedHistory(conversationId, 8)
  await fold(conversationId, { lastMessageId: card.id, coveredCount: 2 })
  await db.transaction((tx) =>
    enqueueAgentWake(
      tx,
      conversationId,
      { turnId: SUBMIT_TURN, taskIds: [taskId], deviceId: DEVICE },
      Date.now(),
    ),
  )

  expect(await pickUpStrandedInboxes()).toBe(1)
  await waitFor(async () => calls.length > 0, 5_000)
  await waitFor(async () => !(await leased(conversationId)), 5_000)

  // 起了轮（在窗口里筛不到会直接撤回），而且这一轮真的点着那个任务的结果。
  const wakePrompt = calls[0]!.messages.filter((message) => message.role === 'user').at(-1)
  expect(JSON.stringify(wakePrompt)).toContain('拍立得版橘猫：失败（上游超时）')
})

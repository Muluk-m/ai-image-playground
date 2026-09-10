import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentMessageView, AgentTurnEvent } from '@image-playground/shared'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  completionStream,
  parseFrames,
  recordingAgentFetch,
  toolCallCompletion,
} from '../helpers/agentStubs'

process.env.DATABASE_URL = await resetTestDatabase('agent_clarify_a296')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-operator-config.json')

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { close: closeDb, db, schema } = await import('../../db/client')

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'

const QUESTION = '这张图要哪种风格？'
const OPTIONS = ['写实照片', '扁平插画']

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
  return parseFrames(await response.text())
}

async function readMessages(conversationId: string): Promise<AgentMessageView[]> {
  const response = await app.handle(
    new Request(
      `http://localhost/api/agent/conversations/${conversationId}/messages?deviceId=${DEVICE}`,
    ),
  )
  return ((await response.json()) as { messages: AgentMessageView[] }).messages
}

function types(frames: { event: AgentTurnEvent }[]): string[] {
  return frames.map((frame) => frame.event.type)
}

/** 依次回答每一次上游请求；用完之后重复最后一条，免得跑飞的循环挂住测试。 */
function scriptedAgentFetch(calls: AgentCall[], answers: Array<() => Response>) {
  let at = 0
  return recordingAgentFetch(calls, () => (answers[at++] ?? answers.at(-1)!)())
}

function clarificationCall(id: string, options: readonly string[]) {
  return toolCallCompletion({
    id,
    name: 'askClarification',
    args: { question: QUESTION, options: [...options] },
  })
}

beforeEach(async () => {
  await db.delete(schema.agent_conversations)
})

afterEach(() => {
  setAgentFetchForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('智能体澄清', () => {
  it('ends the turn on the clarification and answers it in the next turn', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => clarificationCall('call-1', OPTIONS),
        () => completionStream('好的，用写实照片'),
      ]),
    )
    const conversationId = await startConversation()

    const asked = await runTurn(conversationId, '给我画个杯子')

    // 澄清就是这一轮的收尾：它之后没有助手回复，轮直接结算。
    expect(types(asked)).toEqual(['turnStart', 'clarification', 'turnEnd'])
    const clarification = asked[1]!.event
    expect(clarification).toMatchObject({
      type: 'clarification',
      question: QUESTION,
      options: OPTIONS,
    })
    const end = asked.at(-1)!.event
    expect(end).toMatchObject({ type: 'turnEnd', stopReason: 'completed' })
    expect(end.type === 'turnEnd' && end.usage).toEqual({ inputTokens: 12, outputTokens: 4 })
    // 澄清那一轮只调了一次上游：工具结果没有被喂回去再要一句回复。
    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools?.map((tool) => tool.function.name)).toContain('askClarification')

    const askedMessages = await readMessages(conversationId)
    expect(askedMessages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(askedMessages[1]!.content).toEqual([
      { type: 'clarification', question: QUESTION, options: OPTIONS },
    ])
    expect(askedMessages[1]!.id).toBe(
      clarification.type === 'clarification' ? clarification.messageId : '',
    )

    // 用户点了第一项：它作为下一条用户消息开启新的一轮。
    const answered = await runTurn(conversationId, OPTIONS[0]!)
    expect(types(answered)).toEqual(['turnStart', 'assistantStart', 'textDelta', 'turnEnd'])

    const replayed = calls[1]!.messages
    expect(replayed.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(String(JSON.stringify(replayed[2]!.content))).toContain(QUESTION)

    const messages = await readMessages(conversationId)
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])
    expect(messages[2]!.content).toEqual([{ type: 'text', text: OPTIONS[0]! }])
  })

  it('refuses more options than the cap and lets the model ask again', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => clarificationCall('call-1', ['一', '二', '三', '四', '五']),
        () => completionStream('那我按写实来'),
      ]),
    )
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '给我画个杯子')

    expect(types(frames)).not.toContain('clarification')
    expect(types(frames).at(-1)).toBe('turnEnd')
    const end = frames.at(-1)!.event
    expect(end).toMatchObject({ type: 'turnEnd', stopReason: 'completed' })

    const messages = await readMessages(conversationId)
    expect(messages.flatMap((message) => message.content.map((block) => block.type))).toEqual([
      'text',
      'text',
    ])
  })
})

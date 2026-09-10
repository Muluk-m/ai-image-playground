import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentMessageView, AgentTurnEvent } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  completionStream,
  parseFrames,
  recordingAgentFetch,
  toolCallCompletion,
} from '../helpers/agentStubs'

process.env.DATABASE_URL = await resetTestDatabase('agent_tools_a289')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-operator-config.json')

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { setAgentImagePollingForTesting } = await import('../../lib/agent/tools/generateImage')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { close: closeDb, db, schema } = await import('../../db/client')

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'

const IMAGE_CHANNEL = {
  id: 'openai-images',
  kind: 'openai-queue' as const,
  label: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  auth: { type: 'bearer' as const, secretRef: 'OPENAI_API_KEY', secret: 'k' },
  allowedPaths: ['images/generations'],
  models: [
    {
      id: 'gpt-image-2.5-flare',
      label: 'GPT Image 2.5 Flare',
      capabilities: ['generate' as const],
    },
  ],
  defaults: { apiMode: 'images' as const, timeout: 600 },
}

const RESULT_PAYLOAD = { data: [{ b64_json: 'aGk=', mime: 'image/png' }] }

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

function events<T extends AgentTurnEvent['type']>(
  frames: { event: AgentTurnEvent }[],
  type: T,
): Extract<AgentTurnEvent, { type: T }>[] {
  return frames
    .map((frame) => frame.event)
    .filter((event): event is Extract<AgentTurnEvent, { type: T }> => event.type === type)
}

/** 测试里的迷你 worker：把工具刚提交的任务推到终态，让工具循环能往下跑。 */
function settleSubmittedTasks(outcome: 'completed' | 'failed'): () => void {
  let stopped = false
  void (async () => {
    while (!stopped) {
      await db
        .update(schema.tasks)
        .set(
          outcome === 'completed'
            ? { status: 'completed', result_payload: RESULT_PAYLOAD, completed_at: Date.now() }
            : { status: 'failed', error_message: '上游拒绝了这张图', error_type: 'upstream_error' },
        )
        .where(eq(schema.tasks.status, 'queued'))
      await Bun.sleep(2)
    }
  })()
  return () => {
    stopped = true
  }
}

/** 依次回答每一次上游请求；用完之后重复最后一条，免得跑飞的循环挂住测试。 */
function scriptedAgentFetch(calls: AgentCall[], answers: Array<() => Response>) {
  let at = 0
  return recordingAgentFetch(calls, () => (answers[at++] ?? answers.at(-1)!)())
}

beforeEach(async () => {
  _setChannelsForTesting([IMAGE_CHANNEL])
  setAgentImagePollingForTesting({ intervalMs: 2, budgetMs: 5_000 })
  await db.delete(schema.tasks)
  await db.delete(schema.agent_conversations)
})

afterEach(() => {
  setAgentFetchForTesting()
  setAgentImagePollingForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('智能体生图工具', () => {
  it('reports one tool call and links the image task to the turn', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion({
            id: 'call-1',
            name: 'generateImage',
            args: { prompt: '一只橘猫坐在窗台上' },
          }),
        () => completionStream('画好了'),
      ]),
    )
    const stop = settleSubmittedTasks('completed')
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '画一只橘猫坐在窗台上')
    stop()

    expect(types(frames)).toEqual([
      'turnStart',
      'toolStart',
      'toolProgress',
      'toolEnd',
      'assistantStart',
      'textDelta',
      'turnEnd',
    ])
    expect(frames.map((frame) => frame.id)).toEqual([1, 2, 3, 4, 5, 6, 7])

    const [start] = events(frames, 'toolStart')
    expect(start).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'generateImage',
      title: '一只橘猫坐在窗台上',
    })
    const [end] = events(frames, 'toolEnd')
    expect(end).toMatchObject({
      messageId: start!.messageId,
      toolCallId: 'call-1',
      status: 'succeeded',
      title: '一只橘猫坐在窗台上',
    })
    expect(end!.images).toHaveLength(1)
    const image = end!.images![0]!
    expect(image.outputIndex).toBe(0)
    expect(image.mime).toBe('image/png')
    expect(image.imageId).toBeTruthy()

    const turnStart = events(frames, 'turnStart')[0]!
    const [task] = await db.select().from(schema.tasks)
    expect(task!.id).toBe(image.taskId)
    expect(task!.agent_conversation_id).toBe(conversationId)
    expect(task!.agent_turn_id).toBe(turnStart.turnId)
    expect(task!.model).toBe('gpt-image-2.5-flare')
    expect(task!.provider).toBe('openai-compat')
    expect(task!.request_payload.prompt).toBe('一只橘猫坐在窗台上')

    // 工具结果自己占一条助手消息，翻历史时结果卡与文字回复各就各位。
    const messages = await readMessages(conversationId)
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(messages[1]!.content).toEqual([
      {
        type: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'generateImage',
        status: 'succeeded',
        title: '一只橘猫坐在窗台上',
        images: [image],
      },
    ])
    expect(messages[2]!.content).toEqual([{ type: 'text', text: '画好了' }])

    // 工具清单随每次请求发上去，模型才知道有生图这件事可做。
    expect(calls[0]!.tools?.map((tool) => tool.function.name)).toEqual(['generateImage'])
  })

  it('reports two tool calls in one turn independently', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion(
            { id: 'call-1', name: 'generateImage', args: { prompt: '橘猫' } },
            { id: 'call-2', name: 'generateImage', args: { prompt: '黑猫' } },
          ),
        () => completionStream('两张都好了'),
      ]),
    )
    const stop = settleSubmittedTasks('completed')
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '画两只猫')
    stop()

    const starts = events(frames, 'toolStart')
    expect(starts.map((event) => event.toolCallId)).toEqual(['call-1', 'call-2'])
    expect(starts.map((event) => event.title)).toEqual(['橘猫', '黑猫'])
    // 两次调用各占一条助手消息，结果卡因此不会互相覆盖。
    expect(new Set(starts.map((event) => event.messageId)).size).toBe(2)

    const ends = events(frames, 'toolEnd')
    expect(ends.map((event) => event.status)).toEqual(['succeeded', 'succeeded'])
    const imageIds = ends.flatMap((event) => (event.images ?? []).map((image) => image.imageId))
    expect(new Set(imageIds).size).toBe(2)

    const tasks = await db.select().from(schema.tasks)
    expect(tasks).toHaveLength(2)
    expect(tasks.map((task) => task.request_payload.prompt).sort()).toEqual(['橘猫', '黑猫'])
  })

  it('fails the turn when the image task fails', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion({ id: 'call-1', name: 'generateImage', args: { prompt: '橘猫' } }),
        () => completionStream('不该走到这里'),
      ]),
    )
    const stop = settleSubmittedTasks('failed')
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '画一只橘猫')
    stop()

    const [end] = events(frames, 'toolEnd')
    expect(end).toMatchObject({ toolCallId: 'call-1', status: 'failed' })
    expect(end!.message).toContain('上游拒绝了这张图')

    const turnEnd = events(frames, 'turnEnd')[0]!
    expect(turnEnd.stopReason).toBe('failed')
    expect(turnEnd.error).toBe('agent_tool_failed')

    // 图片任务留在失败终态，退回由现有的结算路径负责，工具不另做一套。
    const [task] = await db.select().from(schema.tasks)
    expect(task!.status).toBe('failed')
  })

  it('replays a stored tool result to the model on the next turn', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion({ id: 'call-1', name: 'generateImage', args: { prompt: '橘猫' } }),
        () => completionStream('画好了'),
        () => completionStream('好的'),
      ]),
    )
    const stop = settleSubmittedTasks('completed')
    const conversationId = await startConversation()

    await runTurn(conversationId, '画一只橘猫')
    await runTurn(conversationId, '再说说这张图')
    stop()

    const replayed = calls.at(-1)!.messages
    expect(replayed.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'assistant',
      'user',
    ])
    expect(JSON.stringify(replayed[2])).toContain('橘猫')
  })
})

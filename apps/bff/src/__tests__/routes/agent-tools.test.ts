import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentMessageView, AgentTurnEvent } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  completionStream,
  eventsOfType,
  parseFrames,
  scriptedAgentFetch,
  TEST_IMAGE_CHANNEL,
  TEST_RESULT_PAYLOAD,
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
const { setQueueTaskPollingForTesting } = await import('../../lib/taskSubmission')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { close: closeDb, db, schema } = await import('../../db/client')

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'

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

/** 测试里的迷你 worker：把工具刚提交的任务推到终态，让工具循环能往下跑。 */
function settleSubmittedTasks(outcome: 'completed' | 'failed'): () => void {
  let stopped = false
  void (async () => {
    while (!stopped) {
      await db
        .update(schema.tasks)
        .set(
          outcome === 'completed'
            ? { status: 'completed', result_payload: TEST_RESULT_PAYLOAD, completed_at: Date.now() }
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

beforeEach(async () => {
  _setChannelsForTesting([TEST_IMAGE_CHANNEL])
  setQueueTaskPollingForTesting({ intervalMs: 2, budgetMs: 30_000 })
  await db.delete(schema.tasks)
  await db.delete(schema.agent_conversations)
})

afterEach(() => {
  setAgentFetchForTesting()
  setQueueTaskPollingForTesting()
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

    const [start] = eventsOfType(frames, 'toolStart')
    expect(start).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'generateImage',
      title: '一只橘猫坐在窗台上',
    })
    const [end] = eventsOfType(frames, 'toolEnd')
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

    const turnStart = eventsOfType(frames, 'turnStart')[0]!
    const [task] = await db.select().from(schema.tasks)
    expect(task!.id).toBe(image.taskId)
    expect(task!.agent_conversation_id).toBe(conversationId)
    expect(task!.agent_turn_id).toBe(turnStart.turnId)
    expect(task!.model).toBe('gpt-image-2.5-flare')
    expect(task!.provider).toBe('openai-compat')
    expect(task!.request_payload.prompt).toBe('一只橘猫坐在窗台上')

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

    expect(calls[0]!.tools?.map((tool) => tool.function.name)).toContain('generateImage')
  })

  it('adds up the usage of every upstream call the tool loop makes', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion({
              id: 'call-1',
              name: 'generateImage',
              args: { prompt: '一只橘猫坐在窗台上' },
            }),
          () => completionStream('画好了'),
        ],
      ),
    )
    const stop = settleSubmittedTasks('completed')
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '画一只橘猫坐在窗台上')
    stop()

    // 两次上游各报 12 / 4；只读末条就会把工具那一次白送。
    const [end] = eventsOfType(frames, 'turnEnd')
    expect(end!.usage).toEqual({ inputTokens: 24, outputTokens: 8 })
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

    const starts = eventsOfType(frames, 'toolStart')
    expect(starts.map((event) => event.toolCallId)).toEqual(['call-1', 'call-2'])
    expect(starts.map((event) => event.title)).toEqual(['橘猫', '黑猫'])
    expect(new Set(starts.map((event) => event.messageId)).size).toBe(2)

    const ends = eventsOfType(frames, 'toolEnd')
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

    const [end] = eventsOfType(frames, 'toolEnd')
    expect(end).toMatchObject({ toolCallId: 'call-1', status: 'failed' })
    expect(end!.message).toContain('上游拒绝了这张图')

    const turnEnd = eventsOfType(frames, 'turnEnd')[0]!
    expect(turnEnd.stopReason).toBe('failed')
    expect(turnEnd.error).toBe('agent_tool_failed')

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

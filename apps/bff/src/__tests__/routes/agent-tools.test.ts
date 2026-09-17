import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  type AgentMessageView,
  type AgentTurnEvent,
  DEVICE_ID_HEADER,
} from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  completionStream,
  eventsOfType,
  parseFrames,
  replyThenToolCall,
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
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)

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

async function runTurn(conversationId: string, text: string, params?: Record<string, unknown>) {
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE, text, ...(params ? { params } : {}) }),
    }),
  )
  return parseFrames(await response.text())
}

async function readMessages(conversationId: string): Promise<AgentMessageView[]> {
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/messages`, {
      headers: { [DEVICE_ID_HEADER]: DEVICE },
    }),
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
      const queued = await db.select().from(schema.tasks).where(eq(schema.tasks.status, 'queued'))
      for (const task of queued) {
        await db
          .update(schema.tasks)
          .set(
            outcome === 'completed'
              ? {
                  status: 'completed',
                  result_payload: {
                    data: Array.from(
                      { length: task.request_payload.n ?? 1 },
                      () => TEST_RESULT_PAYLOAD.data[0]!,
                    ),
                  },
                  completed_at: Date.now(),
                }
              : {
                  status: 'failed',
                  error_message: '上游拒绝了这张图',
                  error_type: 'upstream_error',
                },
          )
          .where(eq(schema.tasks.id, task.id))
      }
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
  it.each([
    'queued',
    'in_progress',
  ] as const)('中止轮会取消 %s 的生成任务，且不再调用模型', async (status) => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion({
            id: 'call-stop',
            name: 'generateImage',
            args: { prompt: '一只橘猫' },
          }),
      ]),
    )
    const conversationId = await startConversation()
    const finished = runTurn(conversationId, '画一只橘猫')
    let task: typeof schema.tasks.$inferSelect | undefined
    for (let i = 0; i < 200 && !task; i++) {
      ;[task] = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.agent_conversation_id, conversationId))
      if (!task) await Bun.sleep(5)
    }
    expect(task).toBeDefined()
    await db.update(schema.tasks).set({ status }).where(eq(schema.tasks.id, task!.id))
    const response = await post(
      `/api/agent/conversations/${conversationId}/turns/${task!.agent_turn_id}/abort`,
      { deviceId: DEVICE },
    )
    expect(response.status).toBe(200)
    const frames = await finished
    expect(frames.at(-1)?.event).toMatchObject({ type: 'turnEnd', stopReason: 'aborted' })
    const [stored] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task!.id))
    expect(stored!.status).toBe('cancelled')
    expect(calls).toHaveLength(1)
  })

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
      prompt: '一只橘猫坐在窗台上',
    })
    const [end] = eventsOfType(frames, 'toolEnd')
    expect(end).toMatchObject({
      messageId: start!.messageId,
      toolCallId: 'call-1',
      status: 'succeeded',
      title: '一只橘猫坐在窗台上',
      prompt: '一只橘猫坐在窗台上',
    })
    expect(end!.artifacts).toHaveLength(1)
    const artifact = end!.artifacts![0]!
    expect(artifact.media).toBe('image')
    expect(artifact.outputIndex).toBe(0)
    expect(artifact.mime).toBe('image/png')
    expect(artifact.artifactId).toBeTruthy()

    const turnStart = eventsOfType(frames, 'turnStart')[0]!
    const [task] = await db.select().from(schema.tasks)
    expect(task!.id).toBe(artifact.taskId)
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
        prompt: '一只橘猫坐在窗台上',
        artifacts: [artifact],
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

  it('reserves and returns the model-selected count independently for each image call', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion(
            { id: 'call-1', name: 'generateImage', args: { prompt: '橘猫', n: '3' } },
            { id: 'call-2', name: 'generateImage', args: { prompt: '黑猫', n: 2 } },
          ),
        () => completionStream('五张都好了'),
      ]),
    )
    const stop = settleSubmittedTasks('completed')
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '画三张橘猫和两张黑猫')
    stop()

    const starts = eventsOfType(frames, 'toolStart')
    expect(starts.map((event) => event.toolCallId)).toEqual(['call-1', 'call-2'])
    expect(starts.map((event) => event.outputCount)).toEqual([3, 2])
    expect(starts.map((event) => event.title)).toEqual(['橘猫', '黑猫'])
    expect(new Set(starts.map((event) => event.messageId)).size).toBe(2)

    const ends = eventsOfType(frames, 'toolEnd')
    expect(ends.map((event) => event.status)).toEqual(['succeeded', 'succeeded'])
    expect(ends.map((event) => event.artifacts?.length)).toEqual([3, 2])
    const artifactIds = ends.flatMap((event) =>
      (event.artifacts ?? []).map((artifact) => artifact.artifactId),
    )
    expect(new Set(artifactIds).size).toBe(5)

    const tasks = await db.select().from(schema.tasks)
    expect(tasks).toHaveLength(2)
    expect(tasks.map((task) => task.request_payload.prompt).sort()).toEqual(['橘猫', '黑猫'])
  })

  it('rejects an over-limit image count before creating a task', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion({
              id: 'too-many',
              name: 'generateImage',
              args: { prompt: '橘猫', n: 11 },
            }),
          () => completionStream('不该走到这里'),
        ],
      ),
    )
    const stop = settleSubmittedTasks('completed')
    try {
      const conversationId = await startConversation()
      const frames = await runTurn(conversationId, '画十一张橘猫')
      expect(eventsOfType(frames, 'toolEnd')[0]?.status).toBe('failed')
      expect(await db.select({ id: schema.tasks.id }).from(schema.tasks)).toEqual([])
    } finally {
      stop()
    }
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

  it('keeps the settled reply and tool card of a failed turn', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            replyThenToolCall('我先画一张', {
              id: 'call-1',
              name: 'generateImage',
              args: { prompt: '橘猫' },
            }),
          () => completionStream('不该走到这里'),
        ],
      ),
    )
    const stop = settleSubmittedTasks('failed')
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '画一只橘猫')
    stop()

    expect(eventsOfType(frames, 'turnEnd')[0]).toMatchObject({
      stopReason: 'failed',
      error: 'agent_tool_failed',
    })

    // 轮失败，但这一轮里已经收尾的回复与工具结果是既成事实，照旧留在历史里。
    const messages = await readMessages(conversationId)
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(messages[1]!.content).toEqual([{ type: 'text', text: '我先画一张' }])
    expect(messages[2]!.content[0]).toMatchObject({ type: 'toolResult', status: 'failed' })
  })

  it('keeps the video tool out of a deployment without generation:video', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(scriptedAgentFetch(calls, [() => completionStream('好')]))
    const conversationId = await startConversation()

    await runTurn(conversationId, '你好')

    // `loadSkill` 在场是因为 `apps/bff/skills/image` 里有随仓库发的技能。
    expect(calls[0]!.tools?.map((tool) => tool.function.name).sort()).toEqual([
      'askClarification',
      'editImage',
      'generateImage',
      'loadSkill',
      'readLibrary',
    ])
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

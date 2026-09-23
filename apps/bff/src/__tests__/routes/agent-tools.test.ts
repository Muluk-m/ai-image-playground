import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  type AgentMessageView,
  type AgentToolResultBlock,
  type AgentTurnEvent,
  DEVICE_ID_HEADER,
  projectArtifactId,
  type TaskErrorType,
} from '@image-playground/shared'
import { eq, inArray } from 'drizzle-orm'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  completionStream,
  confirmPendingDrafts,
  eventsOfType,
  parseFrames,
  replyThenToolCall,
  scriptedAgentFetch,
  submittedPrompt,
  TEST_IMAGE_CHANNEL,
  TEST_RESULT_PAYLOAD,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'

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
const { workerSettles } = await import('../helpers/taskWorker')
const { config } = await import('../../config')
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)

await silenceChatUpstream()
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

/** 测试里的迷你 worker：认领工具刚提交的任务并按真实路径收尾，让工具循环能往下跑。 */
function settleSubmittedTasks(
  outcome: 'completed' | 'failed' | 'empty',
  errorType: TaskErrorType = 'upstream_error',
): () => void {
  let stopped = false
  void (async () => {
    while (!stopped) {
      const queued = await db.select().from(schema.tasks).where(eq(schema.tasks.status, 'queued'))
      for (const task of queued) {
        await workerSettles(
          task.id,
          outcome === 'completed'
            ? {
                status: 'completed',
                resultPayload: {
                  data: Array.from(
                    { length: task.request_payload.n ?? 1 },
                    () => TEST_RESULT_PAYLOAD.data[0]!,
                  ),
                },
              }
            : outcome === 'empty'
              ? { status: 'completed', resultPayload: { data: [] } }
              : { status: 'failed', errorMessage: '上游拒绝了这张图', errorType },
        )
      }
      await Bun.sleep(2)
    }
  })()
  return () => {
    stopped = true
  }
}

/** 等 mini worker 把这个会话的任务都推到终态，再读回结算过的消息。 */
async function readSettledMessages(conversationId: string): Promise<AgentMessageView[]> {
  for (let i = 0; i < 400; i++) {
    const pending = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(inArray(schema.tasks.status, ['queued', 'in_progress']))
    if (pending.length === 0) break
    await Bun.sleep(5)
  }
  return readMessages(conversationId)
}

function toolResults(messages: readonly AgentMessageView[]): AgentToolResultBlock[] {
  return messages.flatMap((message) =>
    message.content.filter((block): block is AgentToolResultBlock => block.type === 'toolResult'),
  )
}

/** 这个会话里停在「等确认」的那些卡：拟稿只出卡，任务要到用户确认才有。 */
async function pendingCards(
  conversationId: string,
): Promise<{ messageId: string; block: AgentToolResultBlock }[]> {
  const messages = await readMessages(conversationId)
  return messages.flatMap((message) =>
    message.content.flatMap((block) =>
      block.type === 'toolResult' && block.status === 'awaiting_confirmation'
        ? [{ messageId: message.id, block }]
        : [],
    ),
  )
}

/** 用户在卡上按下「确认生成」。要看回绝状态码的用例不能走 `confirmPendingDrafts`。 */
function confirm(conversationId: string, messageId: string, prompt: string) {
  return post(`/api/agent/conversations/${conversationId}/confirmations`, {
    deviceId: DEVICE,
    messageId,
    prompt,
  })
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
      ]),
    )
    const stop = settleSubmittedTasks('completed')
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '画一只橘猫坐在窗台上')

    // 生图只拟稿：拟完这一轮就收尾，不再回上游要那句结束语。
    expect(types(frames)).toEqual(['turnStart', 'toolStart', 'toolEnd', 'turnEnd'])
    expect(frames.map((frame) => frame.id)).toEqual([1, 2, 3, 4])

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
      status: 'awaiting_confirmation',
      title: '一只橘猫坐在窗台上',
      prompt: '一只橘猫坐在窗台上',
    })
    // 确认之前没有任务，这一轮也就没有东西可挂。
    expect(end!.job).toBeUndefined()
    expect(await db.select({ id: schema.tasks.id }).from(schema.tasks)).toEqual([])

    const [confirmed] = await confirmPendingDrafts(app, conversationId, { deviceId: DEVICE })
    expect(confirmed).toMatchObject({ status: 'submitted', prompt: '一只橘猫坐在窗台上' })

    const turnStart = eventsOfType(frames, 'turnStart')[0]!
    const [task] = await db.select().from(schema.tasks)
    expect(task!.id).toBe(confirmed!.job!.taskId)
    expect(task!.agent_conversation_id).toBe(conversationId)
    expect(task!.agent_turn_id).toBe(turnStart.turnId)
    expect(task!.model).toBe('gpt-image-2.5-flare')
    expect(task!.provider).toBe('openai-compat')
    expect(task!.request_payload.prompt).toBe(submittedPrompt('一只橘猫坐在窗台上'))

    // 任务跑完后读回会话，结果卡已经结算成产物。
    const messages = await readSettledMessages(conversationId)
    stop()
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(messages[1]!.content).toEqual([
      {
        type: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'generateImage',
        status: 'succeeded',
        title: '一只橘猫坐在窗台上',
        prompt: '一只橘猫坐在窗台上',
        artifacts: [
          {
            artifactId: projectArtifactId(task!.id, 0),
            media: 'image',
            taskId: task!.id,
            outputIndex: 0,
            mime: 'image/png',
          },
        ],
        snapshot: start!.snapshot!,
        job: { taskId: task!.id, media: 'image' },
      },
    ])

    expect(calls[0]!.tools?.map((tool) => tool.function.name)).toContain('generateImage')
  })

  it('adds up the usage of every upstream call the tool loop makes', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () => toolCallCompletion({ id: 'call-0', name: 'readLibrary', args: {} }),
          () =>
            toolCallCompletion({
              id: 'call-1',
              name: 'generateImage',
              args: { prompt: '一只橘猫坐在窗台上' },
            }),
        ],
      ),
    )
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '画一只橘猫坐在窗台上')

    // 查素材库那一次让循环继续，拟稿那一次收尾；两次上游各报 12 / 4，只读末条就会白送前一次。
    const [end] = eventsOfType(frames, 'turnEnd')
    expect(end!.usage).toEqual({ inputTokens: 24, outputTokens: 8 })
  })

  it('reserves no canvas slot before confirmation, then honours each count', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion(
            { id: 'call-1', name: 'generateImage', args: { prompt: '橘猫', n: '3' } },
            { id: 'call-2', name: 'generateImage', args: { prompt: '黑猫', n: 2 } },
          ),
      ]),
    )
    const stop = settleSubmittedTasks('completed')
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '画三张橘猫和两张黑猫')

    const starts = eventsOfType(frames, 'toolStart')
    expect(starts.map((event) => event.toolCallId)).toEqual(['call-1', 'call-2'])
    // 稿子可能被改、也可能永远不确认：这一刻一个占位框都不留。
    expect(starts.map((event) => event.outputCount)).toEqual([undefined, undefined])
    expect(starts.map((event) => event.title)).toEqual(['橘猫', '黑猫'])
    expect(new Set(starts.map((event) => event.messageId)).size).toBe(2)

    const ends = eventsOfType(frames, 'toolEnd')
    expect(ends.map((event) => event.status)).toEqual([
      'awaiting_confirmation',
      'awaiting_confirmation',
    ])
    expect(await db.select({ id: schema.tasks.id }).from(schema.tasks)).toEqual([])

    const confirmed = await confirmPendingDrafts(app, conversationId, { deviceId: DEVICE })
    expect(confirmed.map((block) => block.status)).toEqual(['submitted', 'submitted'])

    const settled = toolResults(await readSettledMessages(conversationId))
    stop()
    expect(settled.map((block) => block.status)).toEqual(['succeeded', 'succeeded'])
    expect(settled.map((block) => block.artifacts?.length)).toEqual([3, 2])
    const artifactIds = settled.flatMap((block) =>
      (block.artifacts ?? []).map((artifact) => artifact.artifactId),
    )
    expect(new Set(artifactIds).size).toBe(5)

    const tasks = await db.select().from(schema.tasks)
    expect(tasks).toHaveLength(2)
    // 张数各归各的：确认之后每条任务带的还是模型给它的那个数。
    const submittedTasks = tasks.map((task) => [
      task.request_payload.prompt,
      task.request_payload.n,
    ])
    expect(submittedTasks.sort()).toEqual([
      [submittedPrompt('橘猫'), 3],
      [submittedPrompt('黑猫'), 2],
    ])
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
      const drafts = await db
        .select({ id: schema.agent_generation_drafts.id })
        .from(schema.agent_generation_drafts)
      expect(drafts).toEqual([])
    } finally {
      stop()
    }
  })

  it('settles a failed image task on the card without failing the turn', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion({ id: 'call-1', name: 'generateImage', args: { prompt: '橘猫' } }),
      ]),
    )
    const stop = settleSubmittedTasks('failed')
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '画一只橘猫')

    // 拟完稿这一轮就交还，卡停在等确认上。
    expect(eventsOfType(frames, 'toolEnd')[0]).toMatchObject({
      toolCallId: 'call-1',
      status: 'awaiting_confirmation',
    })
    expect(eventsOfType(frames, 'turnEnd')[0]!.stopReason).toBe('completed')

    await confirmPendingDrafts(app, conversationId, { deviceId: DEVICE })

    // 任务在后台失败，不再把已经交还的这一轮拖成失败。
    const [result] = toolResults(await readSettledMessages(conversationId))
    stop()
    expect(result).toMatchObject({ toolCallId: 'call-1', status: 'failed' })
    expect(result!.message).toContain('上游拒绝了这张图')
    const [task] = await db.select().from(schema.tasks)
    expect(task!.status).toBe('failed')
  })

  it('keeps the settled reply and tool card of a failed turn', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            // 提交前就失败的生图（张数越界）才会把这一轮停下；任务失败已经不在轮里了。
            replyThenToolCall('我先画一张', {
              id: 'call-1',
              name: 'generateImage',
              args: { prompt: '橘猫', n: 11 },
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
      'editCanvasObject',
      'editImage',
      'generateImage',
      'loadSkill',
      'readCanvas',
      'readLibrary',
      'viewImage',
    ])
  })

  it('replays a stored tool result to the model on the next turn', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion({ id: 'call-1', name: 'generateImage', args: { prompt: '橘猫' } }),
        () => completionStream('好的'),
      ]),
    )
    const stop = settleSubmittedTasks('completed')
    const conversationId = await startConversation()

    await runTurn(conversationId, '画一只橘猫')
    await confirmPendingDrafts(app, conversationId, { deviceId: DEVICE })
    await readSettledMessages(conversationId)
    stop()
    await runTurn(conversationId, '再说说这张图')

    const replayed = calls.at(-1)!.messages
    expect(replayed.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(JSON.stringify(replayed[2])).toContain('橘猫')
  })
})

describe('工具调用的参数快照与失败分类', () => {
  it('stores the arguments the model chose, with the turn params and the resolved model', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion({
              id: 'call-1',
              name: 'generateImage',
              args: { prompt: '一只橘猫', n: '2' },
            }),
          () => completionStream('画好了'),
        ],
      ),
    )
    const conversationId = await startConversation()
    const frames = await runTurn(conversationId, '画两张橘猫', {
      size: '1024x1536',
      quality: 'high',
    })

    const snapshot = {
      mode: 'image' as const,
      args: { prompt: '一只橘猫', n: 2 },
      params: { size: '1024x1536', quality: 'high' },
      target: { provider: 'openai-compat', model: 'gpt-image-2.5-flare' },
    }
    // 起跑那一刻就在事件里，结果块里是同一份。
    expect(eventsOfType(frames, 'toolStart')[0]!.snapshot).toEqual(snapshot)
    expect(eventsOfType(frames, 'toolEnd')[0]!.snapshot).toEqual(snapshot)
    const messages = await readMessages(conversationId)
    expect(messages[1]!.content[0]).toMatchObject({ type: 'toolResult', snapshot })
  })

  it.each([
    ['upstream_error', 'upstream_error'],
    ['upstream_timeout', 'timeout'],
    ['upstream_no_image', 'no_output'],
    // 执行者丢了、上游结局查不到：可能已经出图计费，不归进可重试的类。
    ['interrupted', 'result_unknown'],
    ['upstream_result_unknown', 'result_unknown'],
  ] as const)('classifies a task that failed with %s as %s', async (errorType, code) => {
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion({ id: 'call-1', name: 'generateImage', args: { prompt: '橘猫' } }),
          () => completionStream('不该走到这里'),
        ],
      ),
    )
    const stop = settleSubmittedTasks('failed', errorType)
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    await confirmPendingDrafts(app, conversationId, { deviceId: DEVICE })

    // 分类发生在后台任务结算时：读回的结果卡带着错误码。
    const [result] = toolResults(await readSettledMessages(conversationId))
    stop()
    expect(result).toMatchObject({ status: 'failed', errorCode: code })
  })

  it('classifies a finished task without any image as no output', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion({ id: 'call-1', name: 'generateImage', args: { prompt: '橘猫' } }),
          () => completionStream('不该走到这里'),
        ],
      ),
    )
    const stop = settleSubmittedTasks('empty')
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    await confirmPendingDrafts(app, conversationId, { deviceId: DEVICE })

    const [result] = toolResults(await readSettledMessages(conversationId))
    stop()
    expect(result).toMatchObject({ status: 'failed', errorCode: 'no_output' })
  })

  it('classifies arguments rejected before the tool runs as invalid params', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion({
              id: 'call-1',
              name: 'generateImage',
              args: { prompt: '橘猫', n: 11 },
            }),
          () => completionStream('不该走到这里'),
        ],
      ),
    )
    const conversationId = await startConversation()
    const frames = await runTurn(conversationId, '画十一张橘猫')

    expect(eventsOfType(frames, 'toolEnd')[0]).toMatchObject({
      status: 'failed',
      errorCode: 'invalid_params',
    })
  })

  it('classifies an image the model named but cannot be found as invalid params', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion({
              id: 'call-1',
              name: 'editImage',
              args: { prompt: '换成狗', imageIds: ['image 9'] },
            }),
          () => completionStream('那张图找不到'),
        ],
      ),
    )
    const conversationId = await startConversation()
    const frames = await runTurn(conversationId, '把猫换成狗')

    expect(eventsOfType(frames, 'toolEnd')[0]).toMatchObject({
      status: 'failed',
      errorCode: 'invalid_params',
    })
    expect(await db.select({ id: schema.tasks.id }).from(schema.tasks)).toEqual([])
  })

  it('classifies a deployment without any image model as model unavailable', async () => {
    _setChannelsForTesting([])
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion({ id: 'call-1', name: 'generateImage', args: { prompt: '橘猫' } }),
          () => completionStream('不该走到这里'),
        ],
      ),
    )
    const conversationId = await startConversation()
    const frames = await runTurn(conversationId, '画一只橘猫')

    const [end] = eventsOfType(frames, 'toolEnd')
    expect(end).toMatchObject({ status: 'failed', errorCode: 'model_unavailable' })
    // 快照照记，只是没有模型可记。
    expect(end!.snapshot).toMatchObject({ mode: 'image', args: { prompt: '橘猫' } })
    expect(end!.snapshot!.target).toBeUndefined()
  })

  it('records the arguments durably under the tool card the moment the tool starts', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion({ id: 'call-1', name: 'generateImage', args: { prompt: '橘猫' } }),
          () => completionStream('画好了'),
        ],
      ),
    )
    const conversationId = await startConversation()
    const frames = await runTurn(conversationId, '画一只橘猫')

    const recorded = await db
      .select()
      .from(schema.agent_tool_calls)
      .where(eq(schema.agent_tool_calls.conversation_id, conversationId))
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      turn_id: eventsOfType(frames, 'turnStart')[0]!.turnId,
      tool_call_id: 'call-1',
      tool_name: 'generateImage',
      snapshot: { mode: 'image', args: { prompt: '橘猫' } },
    })
    // 起跑记下的那一行对得上结果卡。
    expect(eventsOfType(frames, 'toolStart')[0]!.messageId).toBe(recorded[0]!.message_id)
  })

  it('classifies a used-up daily quota as quota exceeded', async () => {
    const original = config.operator
    config.operator = {
      ...original,
      capabilities: { ...original.capabilities, 'quota:daily': true },
      quotas: { ...original.quotas, 'generation:daily-images': 1 },
    }
    try {
      setAgentFetchForTesting(
        scriptedAgentFetch(
          [],
          [
            () =>
              toolCallCompletion({
                id: 'call-1',
                name: 'generateImage',
                args: { prompt: '橘猫', n: 2 },
              }),
            () => completionStream('不该走到这里'),
          ],
        ),
      )
      const conversationId = await startConversation()
      const frames = await runTurn(conversationId, '画两只橘猫')

      // 额度在提交那一刻才查：稿子照拟，任务卡在确认这一步。
      expect(eventsOfType(frames, 'toolEnd')[0]).toMatchObject({
        status: 'awaiting_confirmation',
      })
      const [pending] = await pendingCards(conversationId)
      const refused = await confirm(conversationId, pending!.messageId, pending!.block.prompt!)

      expect(refused.status).toBe(409)
      expect(refused.json).toEqual({ error: 'confirmation_refused', code: 'quota_exceeded' })
      expect(await db.select({ id: schema.tasks.id }).from(schema.tasks)).toEqual([])
      // 稿子还留着：额度恢复之后还能确认。
      expect((await pendingCards(conversationId))[0]!.block.status).toBe('awaiting_confirmation')
    } finally {
      config.operator = original
    }
  })
})

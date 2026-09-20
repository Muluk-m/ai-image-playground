import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  type AgentBackgroundJobsResponse,
  type AgentMessageView,
  type AgentRetryResponse,
  type AgentToolResultBlock,
  DEVICE_ID_HEADER,
  projectArtifactId,
} from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  completionStream,
  confirmPendingDrafts,
  eventsOfType,
  parseFrames,
  scriptedAgentFetch,
  submittedPrompt,
  TEST_IMAGE_CHANNEL,
  TEST_RESULT_PAYLOAD,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

process.env.DATABASE_URL = await resetTestDatabase('agent_retry_a618')
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
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { appendAgentMessage } = await import('../../lib/agent/conversations')
const { close: closeDb, db, schema } = await import('../../db/client')
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const PROMPT = '一只橘猫坐在窗台上'

function request(path: string, init: { method?: string; body?: unknown } = {}) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        [DEVICE_ID_HEADER]: DEVICE,
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
  expect(response.status).toBe(200)
  return ((await response.json()) as { conversation: { id: string } }).conversation.id
}

async function runTurn(conversationId: string, text: string) {
  const response = await request(`/api/agent/conversations/${conversationId}/turns`, {
    method: 'POST',
    body: { deviceId: DEVICE, text },
  })
  return parseFrames(await response.text())
}

async function readMessages(conversationId: string): Promise<AgentMessageView[]> {
  const response = await request(`/api/agent/conversations/${conversationId}/messages`)
  expect(response.status).toBe(200)
  return ((await response.json()) as { messages: AgentMessageView[] }).messages
}

async function readJobs(conversationId: string): Promise<AgentBackgroundJobsResponse['jobs']> {
  const response = await request(`/api/agent/conversations/${conversationId}/jobs`)
  expect(response.status).toBe(200)
  return ((await response.json()) as AgentBackgroundJobsResponse).jobs
}

function retry(conversationId: string, body: { messageId: string; placeholderId?: string }) {
  return request(`/api/agent/conversations/${conversationId}/retries`, {
    method: 'POST',
    body: { deviceId: DEVICE, ...body },
  })
}

function toolBlock(message: AgentMessageView | undefined): AgentToolResultBlock {
  const block = message?.content[0]
  if (block?.type !== 'toolResult') throw new Error('not a tool result')
  return block
}

/** 测试里的迷你 worker：把任务推到终态，就像它在轮结束之后才跑完。 */
async function finishTask(
  taskId: string,
  outcome: 'completed' | { errorType: string; message?: string },
) {
  await db
    .update(schema.tasks)
    .set(
      outcome === 'completed'
        ? { status: 'completed', result_payload: TEST_RESULT_PAYLOAD, completed_at: Date.now() }
        : {
            status: 'failed',
            error_message: outcome.message ?? '上游出错了',
            error_type: outcome.errorType,
            completed_at: Date.now(),
          },
    )
    .where(eq(schema.tasks.id, taskId))
}

/** 一次两张的生图调用，任务按给定的失败类型失败；返回那张失败卡。 */
async function failedCall(errorType = 'upstream_timeout', calls: AgentCall[] = []) {
  setAgentFetchForTesting(
    scriptedAgentFetch(calls, [
      () =>
        toolCallCompletion({
          id: 'call-1',
          name: 'generateImage',
          args: { prompt: PROMPT, n: 2 },
        }),
      () => completionStream('已开始出 2 张'),
    ]),
  )
  const conversationId = await startConversation()
  const frames = await runTurn(conversationId, '画两张橘猫')
  const [end] = eventsOfType(frames, 'toolEnd')
  // 生成工具只拟稿：这一刻还没有任务，用户在卡上确认之后才提交。
  expect(end!.status).toBe('awaiting_confirmation')
  expect(await db.select().from(schema.tasks)).toEqual([])
  await confirmPendingDrafts(app, conversationId, { deviceId: DEVICE })
  const [task] = await db.select().from(schema.tasks)
  // 这里只看重试：原来那次失败按规则会唤醒智能体（见 agent-wake），先记成已投递，免得唤醒轮
  // 在测试中途抢着调用对话模型。
  await db
    .update(schema.agent_jobs)
    .set({ delivered_at: Date.now() })
    .where(eq(schema.agent_jobs.task_id, task!.id))
  await finishTask(task!.id, { errorType })
  const messages = await readMessages(conversationId)
  const failed = messages.find((message) => message.id === end!.messageId)
  return { conversationId, failed: failed!, originalTaskId: task!.id, calls }
}

beforeEach(async () => {
  _setChannelsForTesting([TEST_IMAGE_CHANNEL])
  setObjectStoreForTesting(new InMemoryObjectStore())
  setQueueTaskPollingForTesting({ intervalMs: 2, budgetMs: 200 })
  await db.delete(schema.tasks)
  await db.delete(schema.agent_conversations)
})

afterEach(() => {
  setAgentFetchForTesting()
  setQueueTaskPollingForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('单张重试', () => {
  it('re-runs one failed placeholder from the snapshot without calling the chat model', async () => {
    const { conversationId, failed, originalTaskId, calls } = await failedCall()
    expect(toolBlock(failed)).toMatchObject({ status: 'failed', errorCode: 'timeout' })
    const modelCalls = calls.length

    const response = await retry(conversationId, {
      messageId: failed.id,
      placeholderId: 'placeholder-2',
    })

    expect(response.status).toBe(200)
    const { message } = (await response.json()) as AgentRetryResponse
    const record = toolBlock(message)
    const tasks = await db.select().from(schema.tasks)
    const retried = tasks.find((task) => task.id !== originalTaskId)!
    expect(record).toMatchObject({
      status: 'submitted',
      toolName: 'generateImage',
      title: toolBlock(failed).title,
      job: { taskId: retried.id, media: 'image' },
      retryOf: { messageId: failed.id, toolCallId: 'call-1', placeholderId: 'placeholder-2' },
    })
    // 按快照重出这一张：同一个模型、同一条提示词（连提交时钉上的 guard 一起照抄），
    // 张数是 1，挂在同一个会话下。
    expect(retried.model).toBe(toolBlock(failed).snapshot!.target!.model)
    expect(retried.request_payload.prompt).toBe(submittedPrompt(PROMPT))
    expect(retried.request_payload.n).toBe(1)
    expect(retried.agent_conversation_id).toBe(conversationId)
    // 不调用对话模型。
    expect(calls).toHaveLength(modelCalls)

    // 重试记录在对话末尾，原失败卡原样不动。
    const messages = await readMessages(conversationId)
    expect(messages.at(-1)?.id).toBe(message.id)
    expect(messages.find((one) => one.id === failed.id)).toEqual(failed)
  })

  it('settles the retry record with the new artifact when the task finishes', async () => {
    const { conversationId, failed, originalTaskId } = await failedCall()
    const { message } = (await (
      await retry(conversationId, { messageId: failed.id })
    ).json()) as AgentRetryResponse
    const retryTaskId = toolBlock(message).job!.taskId
    expect(retryTaskId).not.toBe(originalTaskId)

    await finishTask(retryTaskId, 'completed')

    const job = (await readJobs(conversationId)).find((one) => one.messageId === message.id)
    expect(job!.result).toMatchObject({ status: 'succeeded', retryOf: { messageId: failed.id } })
    expect(job!.result.artifacts?.map((artifact) => artifact.artifactId)).toEqual([
      projectArtifactId(retryTaskId, 0),
    ])
    const original = (await readMessages(conversationId)).find((one) => one.id === failed.id)
    expect(toolBlock(original)).toMatchObject({ status: 'failed', errorCode: 'timeout' })
  })

  it('does not wake the agent when the retry fails', async () => {
    const { conversationId, failed, calls } = await failedCall()
    const modelCalls = calls.length
    const { message } = (await (
      await retry(conversationId, { messageId: failed.id })
    ).json()) as AgentRetryResponse
    const turnsBefore = await db.select().from(schema.agent_turns)

    await finishTask(toolBlock(message).job!.taskId, { errorType: 'upstream_error' })

    const messages = await readMessages(conversationId)
    expect(toolBlock(messages.at(-1))).toMatchObject({
      status: 'failed',
      errorCode: 'upstream_error',
      retryOf: { messageId: failed.id },
    })
    expect(messages.at(-1)?.id).toBe(message.id)
    expect(await db.select().from(schema.agent_turns)).toHaveLength(turnsBefore.length)
    expect(calls).toHaveLength(modelCalls)
  })

  it('tells the model in the next turn that the user retried the call', async () => {
    const calls: AgentCall[] = []
    const { conversationId, failed } = await failedCall('upstream_timeout', calls)
    const { message } = (await (
      await retry(conversationId, { messageId: failed.id })
    ).json()) as AgentRetryResponse
    const retryTaskId = toolBlock(message).job!.taskId
    await finishTask(retryTaskId, 'completed')
    setAgentFetchForTesting(scriptedAgentFetch(calls, [() => completionStream('看到了')]))

    await runTurn(conversationId, '效果怎么样')

    const replay = JSON.stringify(calls.at(-1)!.messages.slice(1))
    expect(replay).toContain(
      `用户重试了「${toolBlock(failed).title}」：完成，图片 ${projectArtifactId(retryTaskId, 0)}`,
    )
  })

  it('cancels a running retry and settles it as cancelled', async () => {
    const { conversationId, failed } = await failedCall()
    const { message } = (await (
      await retry(conversationId, { messageId: failed.id })
    ).json()) as AgentRetryResponse
    const retryTaskId = toolBlock(message).job!.taskId

    const cancelled = await request(
      `/api/agent/conversations/${conversationId}/retries/${message.id}/cancel`,
      { method: 'POST', body: { deviceId: DEVICE } },
    )

    expect(cancelled.status).toBe(200)
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, retryTaskId))
    expect(task!.status).toBe('cancelled')
    const job = (await readJobs(conversationId)).find((one) => one.messageId === message.id)
    expect(job!.result).toMatchObject({ status: 'failed', errorCode: 'cancelled' })

    const again = await request(
      `/api/agent/conversations/${conversationId}/retries/${message.id}/cancel`,
      { method: 'POST', body: { deviceId: DEVICE } },
    )
    expect(again.status).toBe(409)
  })

  it('replays the running retry instead of charging a second one for the same placeholder', async () => {
    const { conversationId, failed } = await failedCall()
    const body = { messageId: failed.id, placeholderId: 'placeholder-1' }

    // 双击，或另一台设备在云端文档刷新之前又点了一次：两次请求同时到。
    const [first, second] = await Promise.all([
      retry(conversationId, body),
      retry(conversationId, body),
    ])
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const a = ((await first.json()) as AgentRetryResponse).message
    const b = ((await second.json()) as AgentRetryResponse).message
    expect(b.id).toBe(a.id)
    expect(await db.select().from(schema.tasks)).toHaveLength(2)

    // 补上之后再点，给回的仍是那一条，不再出第三张。
    await finishTask(toolBlock(a).job!.taskId, 'completed')
    const later = await retry(conversationId, body)
    const replayed = ((await later.json()) as AgentRetryResponse).message
    expect(replayed.id).toBe(a.id)
    expect(toolBlock(replayed).status).toBe('succeeded')
    expect(await db.select().from(schema.tasks)).toHaveLength(2)
    const records = (await readMessages(conversationId)).filter((message) => {
      const block = message.content[0]
      return block?.type === 'toolResult' && block.retryOf
    })
    expect(records).toHaveLength(1)
  })

  it('retries again after the previous retry failed or was cancelled', async () => {
    const { conversationId, failed } = await failedCall()
    const body = { messageId: failed.id, placeholderId: 'placeholder-1' }
    const first = ((await (await retry(conversationId, body)).json()) as AgentRetryResponse).message
    await finishTask(toolBlock(first).job!.taskId, { errorType: 'upstream_error' })

    const second = ((await (await retry(conversationId, body)).json()) as AgentRetryResponse)
      .message
    expect(second.id).not.toBe(first.id)
    await request(`/api/agent/conversations/${conversationId}/retries/${second.id}/cancel`, {
      method: 'POST',
      body: { deviceId: DEVICE },
    })

    const third = ((await (await retry(conversationId, body)).json()) as AgentRetryResponse).message
    expect(new Set([first.id, second.id, third.id]).size).toBe(3)
    // 另一个失败占位是另一次重试，不被这一次挡住。
    const other = (
      (await (
        await retry(conversationId, { messageId: failed.id, placeholderId: 'placeholder-2' })
      ).json()) as AgentRetryResponse
    ).message
    expect(other.id).not.toBe(third.id)
  })

  it('writes the retry record in line with a turn that is writing messages', async () => {
    const { conversationId, failed } = await failedCall()
    // 在跑的那一轮按自己的执行事务一条条写消息，用户同时在两个失败占位上点了重试。
    const turnId = crypto.randomUUID()
    const turnWrites = Array.from({ length: 8 }, (_, index) =>
      db.transaction((tx) =>
        appendAgentMessage(tx, {
          conversationId,
          turnId,
          role: 'assistant',
          content: [{ type: 'text', text: `第 ${index + 1} 段` }],
        }),
      ),
    )
    const retries = [
      retry(conversationId, { messageId: failed.id, placeholderId: 'placeholder-1' }),
      retry(conversationId, { messageId: failed.id, placeholderId: 'placeholder-2' }),
    ]

    const written = await Promise.all(turnWrites)
    const responses = await Promise.all(retries)

    expect(written).toHaveLength(8)
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    const rows = await db
      .select({ seq: schema.agent_messages.seq })
      .from(schema.agent_messages)
      .where(eq(schema.agent_messages.conversation_id, conversationId))
    const seqs = rows.map((row) => row.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('only cancels retry records', async () => {
    const { conversationId, failed } = await failedCall()
    const response = await request(
      `/api/agent/conversations/${conversationId}/retries/${failed.id}/cancel`,
      { method: 'POST', body: { deviceId: DEVICE } },
    )
    expect(response.status).toBe(404)
  })

  it.each([
    ['interrupted', 'result_unknown'],
    ['upstream_result_unknown', 'result_unknown'],
  ])('refuses a failure of type %s (%s)', async (errorType, code) => {
    const { conversationId, failed } = await failedCall(errorType)
    expect(toolBlock(failed).errorCode).toBe(code as AgentToolResultBlock['errorCode'])

    const response = await retry(conversationId, { messageId: failed.id })

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'not_retryable' })
    expect(await db.select().from(schema.tasks)).toHaveLength(1)
  })

  it('refuses a retry of a retry record', async () => {
    const { conversationId, failed } = await failedCall()
    const { message } = (await (
      await retry(conversationId, { messageId: failed.id })
    ).json()) as AgentRetryResponse
    await finishTask(toolBlock(message).job!.taskId, { errorType: 'upstream_error' })
    await readMessages(conversationId)

    const response = await retry(conversationId, { messageId: message.id })

    expect(response.status).toBe(422)
  })

  it.each([
    ['a masked edit', { selectionBindings: [{ imageId: 'img-1', selectionId: 'sel-1' }] }],
    ['one plan of a quoted edit', { requestQuote: '把猫改成蓝色' }],
    [
      'the first step of a chained edit',
      { deferredEdits: [{ targetImageId: 'x', requestQuote: 'y' }] },
    ],
  ])('refuses %s', async (_label, extra) => {
    const { conversationId, failed } = await failedCall()
    const block = toolBlock(failed)
    const local = await appendAgentMessage(db, {
      conversationId,
      turnId: failed.turnId,
      role: 'assistant',
      content: [
        {
          ...block,
          toolCallId: 'call-local',
          toolName: 'editImage',
          snapshot: { ...block.snapshot!, args: { ...block.snapshot!.args, ...extra } },
        },
      ],
    })

    const response = await retry(conversationId, { messageId: local.id })

    expect(response.status).toBe(422)
  })

  it('refuses when the model the call used is no longer offered', async () => {
    const { conversationId, failed } = await failedCall()
    _setChannelsForTesting([
      {
        ...TEST_IMAGE_CHANNEL,
        models: [{ id: 'another-model', label: 'Another', capabilities: ['generate' as const] }],
      },
    ])

    const response = await retry(conversationId, { messageId: failed.id })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'retry_refused', code: 'model_unavailable' })
    expect(await db.select().from(schema.tasks)).toHaveLength(1)
  })

  it('does not retry a card of someone else', async () => {
    const { conversationId, failed } = await failedCall()
    const response = await app.handle(
      new Request(`http://localhost/api/agent/conversations/${conversationId}/retries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: 'device-zzzzzzzz', messageId: failed.id }),
      }),
    )
    expect(response.status).toBe(404)
    expect(await db.select().from(schema.tasks)).toHaveLength(1)
  })
})

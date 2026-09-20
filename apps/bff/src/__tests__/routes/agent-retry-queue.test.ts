import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  type AgentBackgroundJobsResponse,
  type AgentMessageView,
  type AgentRetryResponse,
  type AgentToolResultBlock,
  DEVICE_ID_HEADER,
} from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { _setPrivateBffOverlayForTesting } from '../../lib/private-overlay'
import {
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
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'

process.env.DATABASE_URL = await resetTestDatabase('agent_retry_queue_a619')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-billing-operator-config.json')

const billing = installRecordingTaskHooks()

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { setQueueTaskPollingForTesting } = await import('../../lib/taskSubmission')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { pickUpRetryQueues } = await import('../../lib/agent/retry')
const { close: closeDb, db, schema } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
/** 同一个账号的另一台设备。 */
const OTHER_DEVICE = 'device-zyxwvuts'
const USER_ID = 'agent-retry-queue-user'
const PROMPT = '一只橘猫坐在窗台上'
let sessionToken = ''

function request(path: string, init: { method?: string; body?: unknown; device?: string } = {}) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        [DEVICE_ID_HEADER]: init.device ?? DEVICE,
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
  expect(response.status).toBe(200)
  return ((await response.json()) as { conversation: { id: string } }).conversation.id
}

async function readMessages(conversationId: string, device = DEVICE) {
  const response = await request(`/api/agent/conversations/${conversationId}/messages`, { device })
  expect(response.status).toBe(200)
  return ((await response.json()) as { messages: AgentMessageView[] }).messages
}

async function readJobs(conversationId: string, device = DEVICE) {
  const response = await request(`/api/agent/conversations/${conversationId}/jobs`, { device })
  expect(response.status).toBe(200)
  return ((await response.json()) as AgentBackgroundJobsResponse).jobs
}

async function retry(conversationId: string, messageId: string, placeholderId: string) {
  const response = await request(`/api/agent/conversations/${conversationId}/retries`, {
    method: 'POST',
    body: { deviceId: DEVICE, messageId, placeholderId },
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as AgentRetryResponse).message
}

function withdraw(conversationId: string, messageId: string, device = DEVICE) {
  return request(`/api/agent/conversations/${conversationId}/retries/${messageId}/cancel`, {
    method: 'POST',
    body: { deviceId: device },
    device,
  })
}

function toolBlock(message: AgentMessageView | undefined): AgentToolResultBlock {
  const block = message?.content[0]
  if (block?.type !== 'toolResult') throw new Error('not a tool result')
  return block
}

async function recordOf(conversationId: string, id: string) {
  return toolBlock((await readMessages(conversationId)).find((message) => message.id === id))
}

async function taskCount(): Promise<number> {
  return (await db.select({ id: schema.tasks.id }).from(schema.tasks)).length
}

/** 测试里的迷你 worker：把任务推到终态，就像它在轮结束之后才跑完。 */
async function finishTask(taskId: string, outcome: 'completed' | 'failed') {
  await db
    .update(schema.tasks)
    .set(
      outcome === 'completed'
        ? { status: 'completed', result_payload: TEST_RESULT_PAYLOAD, completed_at: Date.now() }
        : {
            status: 'failed',
            error_message: '上游出错了',
            error_type: 'upstream_error',
            completed_at: Date.now(),
          },
    )
    .where(eq(schema.tasks.id, taskId))
}

/** 一次三张的生图调用，任务超时失败；返回会话与那张失败卡。 */
async function failedCall() {
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'call-1',
            name: 'generateImage',
            args: { prompt: PROMPT, n: 3 },
          }),
        () => completionStream('已开始出 3 张'),
      ],
    ),
  )
  const conversationId = await startConversation()
  const response = await request(`/api/agent/conversations/${conversationId}/turns`, {
    method: 'POST',
    body: { deviceId: DEVICE, text: '画三张橘猫' },
  })
  const frames = parseFrames(await response.text())
  const [end] = eventsOfType(frames, 'toolEnd')
  // 生成工具只拟稿：这一刻还没有任务，用户在卡上确认之后才提交。
  expect(end!.status).toBe('awaiting_confirmation')
  expect(await db.select().from(schema.tasks).where(eq(schema.tasks.kind, 'queue'))).toEqual([])
  await confirmPendingDrafts(app, conversationId, {
    deviceId: DEVICE,
    cookie: `${USER_SESSION_COOKIE}=${sessionToken}`,
  })
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.kind, 'queue'))
  // 这里只看重试：原来那次失败按规则会唤醒智能体（见 agent-wake），先记成已投递，免得唤醒轮
  // 在测试中途抢着调用对话模型。
  await db
    .update(schema.agent_jobs)
    .set({ delivered_at: Date.now() })
    .where(eq(schema.agent_jobs.task_id, task!.id))
  await db
    .update(schema.tasks)
    .set({
      status: 'failed',
      error_message: '上游超时',
      error_type: 'upstream_timeout',
      completed_at: Date.now(),
    })
    .where(eq(schema.tasks.id, task!.id))
  const failed = (await readMessages(conversationId)).find((one) => one.id === end!.messageId)!
  expect(toolBlock(failed)).toMatchObject({ status: 'failed', errorCode: 'timeout' })
  return { conversationId, failed }
}

beforeEach(async () => {
  billing.reset()
  _setChannelsForTesting([TEST_IMAGE_CHANNEL])
  setObjectStoreForTesting(new InMemoryObjectStore())
  setQueueTaskPollingForTesting({ intervalMs: 2, budgetMs: 200 })
  await db.delete(schema.tasks)
  await db.delete(schema.agent_conversations)
  await db.delete(schema.user_sessions)
  await db.delete(schema.users)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: USER_ID,
    username: 'agent.retry.queue',
    password_hash: 'hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  sessionToken = await db.transaction((tx) => createUserSession(USER_ID, tx))
})

afterEach(() => {
  setAgentFetchForTesting()
  setQueueTaskPollingForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  _setPrivateBffOverlayForTesting()
  await closeDb()
})

describe('重试排队', () => {
  it('runs retries one after another and shows the queued ones on every device', async () => {
    const { conversationId, failed } = await failedCall()
    const before = await taskCount()

    const first = await retry(conversationId, failed.id, 'placeholder-1')
    const second = await retry(conversationId, failed.id, 'placeholder-2')
    const third = await retry(conversationId, failed.id, 'placeholder-3')

    // 第一条当场提交，后两条排着：没有任务、没有扣费。
    expect(toolBlock(first).status).toBe('submitted')
    expect(toolBlock(second)).toMatchObject({
      status: 'queued',
      retryOf: { messageId: failed.id, placeholderId: 'placeholder-2' },
    })
    expect(toolBlock(second).job).toBeUndefined()
    expect(toolBlock(third).status).toBe('queued')
    expect(await taskCount()).toBe(before + 1)

    // 刷新、换一台设备：排队态来自服务端，看到的是同一份。
    const elsewhere = await readJobs(conversationId, OTHER_DEVICE)
    expect(
      elsewhere
        .filter((job) => job.result.retryOf)
        .map((job) => [job.messageId, job.result.status]),
    ).toEqual([
      [first.id, 'submitted'],
      [second.id, 'queued'],
      [third.id, 'queued'],
    ])
    const history = await readMessages(conversationId, OTHER_DEVICE)
    expect(toolBlock(history.find((one) => one.id === second.id)).status).toBe('queued')

    // 在跑的那条没结束，问多少次也不提交下一条。
    await readJobs(conversationId)
    expect(await taskCount()).toBe(before + 1)

    // 前一条结束，下一条接上；再下一条仍然排着。
    await finishTask(toolBlock(first).job!.taskId, 'completed')
    const jobs = await readJobs(conversationId)
    const next = jobs.find((job) => job.messageId === second.id)!
    expect(next.result).toMatchObject({ status: 'submitted', job: { media: 'image' } })
    expect(jobs.find((job) => job.messageId === third.id)!.result.status).toBe('queued')
    expect(await taskCount()).toBe(before + 2)
    const [submitted] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, next.result.job!.taskId))
    expect(submitted!.request_payload.n).toBe(1)
    expect(submitted!.request_payload.prompt).toBe(submittedPrompt(PROMPT))
    expect(submitted!.user_id).toBe(USER_ID)
    expect(submitted!.agent_turn_id).toBe(second.turnId)

    // 重试记录按点击的先后留在对话末尾。
    const ids = (await readMessages(conversationId)).slice(-3).map((one) => one.id)
    expect(ids).toEqual([first.id, second.id, third.id])
  })

  it('advances the queue without any client once the running retry ends', async () => {
    const { conversationId, failed } = await failedCall()
    const first = await retry(conversationId, failed.id, 'placeholder-1')
    const second = await retry(conversationId, failed.id, 'placeholder-2')

    await finishTask(toolBlock(first).job!.taskId, 'failed')
    // 服务端自己的巡检：没有人在看这个会话。
    await pickUpRetryQueues(true)

    const record = await recordOf(conversationId, second.id)
    expect(record.status).toBe('submitted')
    expect(record.job?.taskId).toBeDefined()
  })

  it('replays a queued retry instead of queueing the same placeholder twice', async () => {
    const { conversationId, failed } = await failedCall()
    await retry(conversationId, failed.id, 'placeholder-1')
    const queued = await retry(conversationId, failed.id, 'placeholder-2')

    const again = await retry(conversationId, failed.id, 'placeholder-2')

    expect(again.id).toBe(queued.id)
    const records = (await readMessages(conversationId)).filter((message) => {
      const block = message.content[0]
      return block?.type === 'toolResult' && block.retryOf
    })
    expect(records).toHaveLength(2)
  })

  it('withdraws a queued retry, from any device, back to the failed placeholder', async () => {
    const { conversationId, failed } = await failedCall()
    const first = await retry(conversationId, failed.id, 'placeholder-1')
    const second = await retry(conversationId, failed.id, 'placeholder-2')
    const tasksBefore = await taskCount()

    const response = await withdraw(conversationId, second.id, OTHER_DEVICE)

    expect(response.status).toBe(200)
    expect(await recordOf(conversationId, second.id)).toMatchObject({
      status: 'failed',
      errorCode: 'cancelled',
      retryOf: { messageId: failed.id, placeholderId: 'placeholder-2' },
    })
    // 客户端只从后台任务列表得知终局：撤回的那条留在列表里，带着撤回的码，没有任务。
    const listed = (await readJobs(conversationId, DEVICE)).find(
      (job) => job.messageId === second.id,
    )
    expect(listed?.result).toMatchObject({
      status: 'failed',
      errorCode: 'cancelled',
      message: '重试已撤回',
      retryOf: { messageId: failed.id, placeholderId: 'placeholder-2' },
    })
    expect(listed?.result.job).toBeUndefined()
    // 撤回的那条不会在前一条结束后被提交，也不扣费。
    await finishTask(toolBlock(first).job!.taskId, 'completed')
    await readJobs(conversationId)
    expect(await taskCount()).toBe(tasksBefore)
    // 再撤一次：它已经不在队里了。
    expect((await withdraw(conversationId, second.id)).status).toBe(409)
    // 撤回之后这个占位还能再点重试。
    const again = await retry(conversationId, failed.id, 'placeholder-2')
    expect(again.id).not.toBe(second.id)
    expect(toolBlock(again).status).toBe('submitted')
  })

  it('submits the next queued retry when the running one is cancelled', async () => {
    const { conversationId, failed } = await failedCall()
    const first = await retry(conversationId, failed.id, 'placeholder-1')
    const second = await retry(conversationId, failed.id, 'placeholder-2')

    expect((await withdraw(conversationId, first.id)).status).toBe(200)

    expect(await recordOf(conversationId, first.id)).toMatchObject({
      status: 'failed',
      errorCode: 'cancelled',
    })
    expect((await recordOf(conversationId, second.id)).status).toBe('submitted')
  })

  it('withdraws every remaining retry when the next one runs out of credits', async () => {
    const { conversationId, failed } = await failedCall()
    const first = await retry(conversationId, failed.id, 'placeholder-1')
    const second = await retry(conversationId, failed.id, 'placeholder-2')
    const third = await retry(conversationId, failed.id, 'placeholder-3')
    const tasksBefore = await taskCount()

    billing.answer = { kind: 'insufficient_credits', required: 10, available: 2 }
    await finishTask(toolBlock(first).job!.taskId, 'completed')
    await readJobs(conversationId)

    // 轮到的那条带着积分不足的码失败，界面据此引导充值；剩下的撤回成原来的失败占位。
    expect(await recordOf(conversationId, second.id)).toMatchObject({
      status: 'failed',
      errorCode: 'insufficient_credits',
    })
    expect(await recordOf(conversationId, third.id)).toMatchObject({
      status: 'failed',
      errorCode: 'cancelled',
    })
    expect(await taskCount()).toBe(tasksBefore)
    // 这两条的终局也在后台任务列表里：别的设备据此引导充值、把占位收回原来那次失败。
    const listed = await readJobs(conversationId, OTHER_DEVICE)
    const resultOf = (id: string) => listed.find((job) => job.messageId === id)?.result
    expect(resultOf(second.id)).toMatchObject({
      status: 'failed',
      errorCode: 'insufficient_credits',
      message: '重试没能提交（insufficient_credits）',
      retryOf: { messageId: failed.id, placeholderId: 'placeholder-2' },
    })
    expect(resultOf(second.id)?.job).toBeUndefined()
    expect(resultOf(third.id)).toMatchObject({
      status: 'failed',
      errorCode: 'cancelled',
      message: '前一条重试没能提交（insufficient_credits），排队的重试已撤回',
      retryOf: { messageId: failed.id, placeholderId: 'placeholder-3' },
    })
    expect(resultOf(third.id)?.job).toBeUndefined()
    // 不再有排着的重试，巡检也不会再提交什么。
    billing.answer = { kind: 'reserved', credits: 0 }
    await pickUpRetryQueues(true)
    expect(await taskCount()).toBe(tasksBefore)
  })

  it('fails the queue head that throws on submit and moves on to the next one', async () => {
    const { conversationId, failed } = await failedCall()
    const first = await retry(conversationId, failed.id, 'placeholder-1')
    const second = await retry(conversationId, failed.id, 'placeholder-2')
    const third = await retry(conversationId, failed.id, 'placeholder-3')
    const tasksBefore = await taskCount()

    // 轮到的那条提交时抛错（比如归档的输入图取不回、库出错）：只抛这一次。
    let throws = 1
    const answer = billing.answer
    Object.defineProperty(billing, 'answer', {
      configurable: true,
      get() {
        if (throws-- > 0) throw new Error('archive object missing')
        return answer
      },
    })
    try {
      await finishTask(toolBlock(first).job!.taskId, 'completed')
      // 列后台任务不受它连累；队头收成失败，下一条照常提交。
      const jobs = await readJobs(conversationId)
      const resultOf = (id: string) => jobs.find((job) => job.messageId === id)?.result
      expect(resultOf(second.id)).toMatchObject({ status: 'failed', errorCode: 'unknown' })
      expect(resultOf(second.id)?.job).toBeUndefined()
      expect(resultOf(third.id)).toMatchObject({ status: 'submitted', job: { media: 'image' } })
      expect(await taskCount()).toBe(tasksBefore + 1)
    } finally {
      Object.defineProperty(billing, 'answer', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: answer,
      })
    }
  })

  it('does not queue a retry of a deleted conversation', async () => {
    const { conversationId, failed } = await failedCall()
    const first = await retry(conversationId, failed.id, 'placeholder-1')
    await retry(conversationId, failed.id, 'placeholder-2')
    const tasksBefore = await taskCount()

    const deleted = await request(`/api/agent/conversations/${conversationId}`, {
      method: 'DELETE',
      body: { deviceId: DEVICE },
    })
    expect(deleted.status).toBe(200)
    await finishTask(toolBlock(first).job!.taskId, 'completed')
    await pickUpRetryQueues(true)

    expect(await taskCount()).toBe(tasksBefore)
  })
})

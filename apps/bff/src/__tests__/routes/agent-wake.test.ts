import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  type AgentConversationSnapshot,
  type AgentToolResultBlock,
  DEVICE_ID_HEADER,
  projectArtifactId,
} from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import sharp from 'sharp'
import {
  type AgentCall,
  completionStream,
  confirmPendingDrafts,
  eventsOfType,
  parseFrames,
  readFrames,
  scriptedAgentFetch,
  submittedPrompt,
  TEST_IMAGE_CHANNEL,
  TEST_RESULT_PAYLOAD,
  type ToolCallSpec,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { waitFor } from '../helpers/upstreamStubs'

process.env.DATABASE_URL = await resetTestDatabase('agent_wake_a614')
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
const { cancelTasks } = await import('../../db/task-transitions')
const { workerSettles } = await import('../helpers/taskWorker')
const { pickUpStrandedInboxes } = await import('../../lib/agent/inbox-pickup')
const { AGENT_WAKE_BATCH_WAIT_MS } = await import('../../lib/agent/wake')
const { createQueueTask } = await import('../../lib/taskSubmission')
const { bffDrain } = await import('../../lib/drain')
const { imageSelection } = await import('../../lib/agent/selection-preview')
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)

await silenceChatUpstream()
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'

const PIXEL = `data:image/png;base64,${(
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#ffffff' } })
    .png()
    .toBuffer()
).toString('base64')}`
const MASK = `data:image/png;base64,${(
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#00000000' } })
    .png()
    .toBuffer()
).toString('base64')}`
const SELECTION_ID = (await imageSelection({ dataUrl: PIXEL, maskDataUrl: MASK }))!.id

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

async function runTurn(conversationId: string, text: string, references?: unknown[]) {
  const response = await request(`/api/agent/conversations/${conversationId}/turns`, {
    method: 'POST',
    body: { deviceId: DEVICE, text, ...(references ? { references } : {}) },
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

/** 等唤醒起的那一轮收尾：它的页脚落库、租约放手。 */
async function waitForTurns(conversationId: string, count: number): Promise<void> {
  await waitFor(async () => (await turnIds(conversationId)).length >= count, 5_000)
  await waitFor(async () => !(await leased(conversationId)), 5_000)
}

async function tasksOf(conversationId: string) {
  return (
    db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.agent_conversation_id, conversationId))
      // 与 `agent_jobs` 的排序对齐：同一毫秒确认的两张稿，两处认的先后才是同一个。
      .orderBy(schema.tasks.submitted_at, schema.tasks.id)
  )
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
}

/**
 * 测试里的迷你 worker：认领一条任务、再按真实路径收尾——唤醒判断就发生在收尾的那个事务里。
 */
async function work(taskId: string, outcome: 'completed' | 'failed', completedAt = Date.now()) {
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId))
  const finished = await workerSettles(
    taskId,
    outcome === 'completed'
      ? {
          status: 'completed',
          completedAt,
          resultPayload: {
            data: Array.from(
              { length: task!.request_payload.n ?? 1 },
              () => TEST_RESULT_PAYLOAD.data[0]!,
            ),
          },
        }
      : {
          status: 'failed',
          completedAt,
          errorMessage: '上游超时',
          errorType: 'upstream_timeout',
        },
  )
  expect(finished).toBe(true)
}

/** 用户在卡上按下确认：拟稿之后任务才建出来，凡是要断言提交内容的用例都走一遍它。 */
function confirmDrafts(conversationId: string) {
  return confirmPendingDrafts(app, conversationId, { deviceId: DEVICE })
}

/** 这个会话里此刻还等着用户确认的那几张卡。 */
async function pendingCards(conversationId: string): Promise<AgentToolResultBlock[]> {
  const { messages } = await snapshot(conversationId)
  return messages
    .flatMap((message) => message.content)
    .filter(
      (block): block is AgentToolResultBlock =>
        block.type === 'toolResult' && block.status === 'awaiting_confirmation',
    )
}

/** 按提示词认出这条任务：同一轮的两张稿确认得够近时，提交时刻分不出先后。 */
async function taskFor(conversationId: string, call: string) {
  const tasks = await tasksOf(conversationId)
  return tasks.find((task) => task.request_payload.prompt.includes(call))!
}

/** 写入可以按 key 停住的对象存储：草稿材料卡在归档里时，拟它的那一轮还跑着。 */
class GatedObjectStore extends InMemoryObjectStore {
  hold: ((key: string) => Promise<void> | undefined) | undefined

  override async write(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.hold?.(key)
    return super.write(key, bytes, contentType)
  }
}

function generate(id: string, extra: Record<string, unknown> = {}): ToolCallSpec {
  return { id, name: 'generateImage', args: { prompt: `一只橘猫 ${id}`, ...extra } }
}

/** 模型在某一次请求里收到的最后一条用户输入：唤醒轮就是那段系统说明与附上的证据。 */
function lastUserInput(call: AgentCall): string {
  return JSON.stringify(call.messages.filter((message) => message.role === 'user').at(-1))
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

describe('唤醒', () => {
  it('wakes the agent when a submitted task fails, and the wake turn sees the failure', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion(generate('call-1')),
        () => completionStream('这张没出来，要不要换个说法再试？'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    // 拟稿这一轮什么都没交出去：确认之后才有任务可等。
    expect(await tasksOf(conversationId)).toEqual([])
    await confirmDrafts(conversationId)
    const [task] = await tasksOf(conversationId)

    await work(task!.id, 'failed')
    expect(await wakes(conversationId)).toHaveLength(1)
    expect(await pickUpStrandedInboxes()).toBe(1)
    await waitForTurns(conversationId, 2)

    expect(calls).toHaveLength(2)
    const woken = lastUserInput(calls[1]!)
    expect(woken).toContain('系统通知')
    expect(woken).toContain('失败（上游超时）')
    // 唤醒轮不落用户消息：历史里只有一条用户消息，后面接着智能体的说明。
    const { messages } = await snapshot(conversationId)
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(JSON.stringify(messages.at(-1))).toContain('要不要换个说法')
  })

  it('does not wake the agent for a success it did not ask to review', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion(generate('call-1')),
        () => completionStream('不该有这一轮'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    await confirmDrafts(conversationId)
    const [task] = await tasksOf(conversationId)

    await work(task!.id, 'completed')
    expect(await pickUpStrandedInboxes()).toBe(0)
    expect(await wakes(conversationId)).toHaveLength(0)
    expect(calls).toHaveLength(1)
    expect(await turnIds(conversationId)).toHaveLength(1)
  })

  it('wakes the agent on success when it asked to review, and attaches the artifact', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion(generate('call-1', { reviewAfterCompletion: true })),
        () => completionStream('看过了，符合要求'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫，画完帮我检查一下')
    await confirmDrafts(conversationId)
    const [task] = await tasksOf(conversationId)

    await work(task!.id, 'completed')
    expect(await pickUpStrandedInboxes()).toBe(1)
    await waitForTurns(conversationId, 2)

    const woken = lastUserInput(calls[1]!)
    const artifactId = projectArtifactId(task!.id, 0)
    expect(woken).toContain(`完成，图片 ${artifactId}`)
    // 产物本身作为视觉证据附上，模型看得到它，不只是一个 id。
    expect(woken).toContain(`视觉输入 1：图片 ${artifactId} 原图`)
    expect(woken).toContain(`data:image/png;base64,${TEST_RESULT_PAYLOAD.data[0]!.b64_json}`)
  })

  it('wakes once for a batch, after every task of that submission has ended', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion(generate('call-1'), generate('call-2')),
        () => completionStream('两张都失败了'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画两只不同的猫')
    // 一轮拟两张稿，用户一次都确认了：两条任务同属拟它们的那一轮。
    expect(await confirmDrafts(conversationId)).toHaveLength(2)
    const [first, second] = await tasksOf(conversationId)

    await work(first!.id, 'failed')
    expect(await wakes(conversationId)).toHaveLength(0)
    expect(await pickUpStrandedInboxes()).toBe(0)

    await work(second!.id, 'failed')
    const [wake] = await wakes(conversationId)
    expect(await wakes(conversationId)).toHaveLength(1)
    expect(wake!.payload).toMatchObject({ taskIds: [first!.id, second!.id] })
    expect(await pickUpStrandedInboxes()).toBe(1)
    await waitForTurns(conversationId, 2)
    expect(calls).toHaveLength(2)
    const woken = lastUserInput(calls[1]!)
    expect(woken).toContain('一只橘猫 call-1：失败')
    expect(woken).toContain('一只橘猫 call-2：失败')
  })

  it('wakes with what has ended once the batch waited too long, and again for the straggler', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion(generate('call-1'), generate('call-2')),
        () => completionStream('第一张没出来'),
        () => completionStream('第二张也没出来'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画两只不同的猫')
    await confirmDrafts(conversationId)
    const first = await taskFor(conversationId, 'call-1')
    const second = await taskFor(conversationId, 'call-2')

    const endedAt = Date.now()
    await work(first.id, 'failed', endedAt)
    expect(await pickUpStrandedInboxes(endedAt + AGENT_WAKE_BATCH_WAIT_MS - 1_000)).toBe(0)
    expect(await wakes(conversationId)).toHaveLength(0)

    expect(await pickUpStrandedInboxes(endedAt + AGENT_WAKE_BATCH_WAIT_MS)).toBe(1)
    await waitForTurns(conversationId, 2)
    const [early] = await wakes(conversationId)
    expect(early!.payload).toMatchObject({ taskIds: [first.id] })
    const firstWake = lastUserInput(calls[1]!)
    expect(firstWake).toContain('一只橘猫 call-1：失败')
    expect(firstWake).not.toContain('call-2')

    await work(second.id, 'failed')
    expect(await pickUpStrandedInboxes()).toBe(1)
    await waitForTurns(conversationId, 3)
    expect(lastUserInput(calls[2]!)).toContain('一只橘猫 call-2：失败')
    expect(await wakes(conversationId)).toHaveLength(2)
  })

  it('waits for the submitting turn to end before it wakes, then wakes right after it', async () => {
    // 同一条助手消息里拟两张稿：第一张落了库、用户当场确认，第二张的材料还卡在归档。任务这时
    // 失败了，拟它的那一轮还在跑、还可能再拟一张，不能先唤醒。
    const store = new GatedObjectStore()
    let release!: () => void
    const archived = new Promise<void>((resolve) => {
      release = resolve
    })
    // 只挡草稿材料：起轮时归档的那几张引用图走 `agent/` 前缀，照常放行。
    store.hold = (key) => (!key.startsWith('agent/') && key.includes('/in/') ? archived : undefined)
    setObjectStoreForTesting(store)
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion(generate('call-1'), {
            id: 'edit-1',
            name: 'editImage',
            args: { prompt: '再把杯子换成蓝色', imageIds: ['target'] },
          }),
        () => completionStream('刚才那张失败了'),
      ]),
    )
    const conversationId = await startConversation()
    const response = await request(`/api/agent/conversations/${conversationId}/turns`, {
      method: 'POST',
      body: {
        deviceId: DEVICE,
        text: '画一只橘猫，再把杯子换成蓝色',
        references: [{ imageId: 'target', dataUrl: PIXEL }],
      },
    })
    await readFrames(response, 3)
    await waitFor(async () => (await pendingCards(conversationId)).length === 1, 3_000)

    await confirmDrafts(conversationId)
    const [task] = await tasksOf(conversationId)
    await work(task!.id, 'failed')
    expect(await wakes(conversationId)).toHaveLength(0)
    expect(await pickUpStrandedInboxes()).toBe(0)

    release()
    // 那一轮收尾放手时凑齐了这一批，当场唤醒，不必等巡查。
    await waitForTurns(conversationId, 2)
    expect(await wakes(conversationId)).toHaveLength(1)
    expect(lastUserInput(calls[1]!)).toContain('失败（上游超时）')
  })

  it('does not wake the agent for tasks that were cancelled', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion(generate('call-1')),
        () => completionStream('不该有这一轮'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    await confirmDrafts(conversationId)
    const [task] = await tasksOf(conversationId)

    await cancelTasks(eq(schema.tasks.id, task!.id))
    expect(await pickUpStrandedInboxes()).toBe(0)
    expect(await wakes(conversationId)).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })

  it('does not wake the agent when a task the user submitted in the conversation fails', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion(generate('call-1')),
        () => completionStream('不该有这一轮'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    await confirmDrafts(conversationId)
    const [agentTask] = await tasksOf(conversationId)
    const [turnId] = await turnIds(conversationId)
    await work(agentTask!.id, 'completed')

    // 用户自己点的重试：同一个会话、同一轮，但不是智能体的工具提交的，没有后台任务登记。
    const retried = await createQueueTask({
      provider: agentTask!.provider,
      model: agentTask!.model,
      request: { prompt: '一只橘猫', device_id: DEVICE },
      userId: null,
      agent: { conversationId, turnId: turnId! },
    })
    expect(retried.kind).toBe('created')
    if (retried.kind !== 'created') return
    await work(retried.taskId, 'failed')

    expect(await pickUpStrandedInboxes()).toBe(0)
    expect(await wakes(conversationId)).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })

  it('keeps a single executor per conversation while an old instance still holds it', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion(generate('call-1')),
        () => completionStream('这张没出来'),
        () => completionStream('不该有第二个唤醒轮'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    await confirmDrafts(conversationId)
    const [task] = await tasksOf(conversationId)

    // 滚动发布：旧实例还握着这个会话的执行租约（它在跑别的轮）。
    await db
      .insert(schema.agent_executions)
      .values({
        conversation_id: conversationId,
        turn_id: 'old-turn',
        instance: 'old-instance',
        origin: 'http://old.test',
        state: 'running',
        heartbeat_at: Date.now(),
      })
      .onConflictDoUpdate({
        target: schema.agent_executions.conversation_id,
        set: {
          turn_id: 'old-turn',
          instance: 'old-instance',
          origin: 'http://old.test',
          state: 'running',
          heartbeat_at: Date.now(),
        },
      })
    await work(task!.id, 'failed')
    expect(await wakes(conversationId)).toHaveLength(1)
    expect(await pickUpStrandedInboxes()).toBe(0)
    expect(calls).toHaveLength(1)

    // 旧实例收尾放手之后，新旧两个实例同时来接：只有一个起得了轮。
    await db
      .update(schema.agent_executions)
      .set({ state: 'completed' })
      .where(eq(schema.agent_executions.conversation_id, conversationId))
    const started = await Promise.all([pickUpStrandedInboxes(), pickUpStrandedInboxes()])
    expect(started.reduce((sum, one) => sum + one, 0)).toBe(1)
    await waitForTurns(conversationId, 2)
    expect(calls).toHaveLength(2)
    const [wake] = await wakes(conversationId)
    expect(wake!.status).toBe('consumed')
  })
})

describe('局部改图', () => {
  it('drafts the masked edit, submits it on confirmation, and reviews the candidate on wake', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion({
            id: 'edit-1',
            name: 'editImage',
            args: {
              prompt: '把圈里的杯子换成蓝色',
              imageIds: ['target'],
              selectionBindings: [{ imageId: 'target', selectionId: SELECTION_ID }],
            },
          }),
        () => completionStream('检查过了，杯子已经是蓝色'),
      ]),
    )
    const conversationId = await startConversation()
    const frames = await runTurn(conversationId, '把圈里的杯子换成蓝色', [
      { imageId: 'target', dataUrl: PIXEL, maskDataUrl: MASK },
    ])

    // 拟稿即返回：这一轮收尾时还没有任务，卡停在「等待确认」。
    const [end] = eventsOfType(frames, 'toolEnd')
    expect(end).toMatchObject({ toolName: 'editImage', status: 'awaiting_confirmation' })
    expect(frames.at(-1)?.event).toMatchObject({ type: 'turnEnd', stopReason: 'completed' })
    expect(await tasksOf(conversationId)).toEqual([])

    // 用户确认之后才提交：送出去的是卡上那份服务端拼好的执行指令，遮罩跟着一起走。
    const [drafted] = await pendingCards(conversationId)
    await confirmDrafts(conversationId)
    const [task] = await tasksOf(conversationId)
    expect(task!.status).toBe('queued')
    expect(task!.request_payload.prompt).toBe(submittedPrompt(drafted!.prompt!))
    expect(task!.request_payload.mask).toBeTruthy()

    // 候选出来了：模型没选复核也一定被唤醒，看着候选检查。
    await work(task!.id, 'completed')
    expect(await pickUpStrandedInboxes()).toBe(1)
    await waitForTurns(conversationId, 2)
    const woken = lastUserInput(calls[1]!)
    const artifactId = projectArtifactId(task!.id, 0)
    expect(woken).toContain('需要复核')
    expect(woken).toContain(`图片 ${artifactId} 原图`)
    const { messages } = await snapshot(conversationId)
    const card = messages
      .flatMap((message) => message.content)
      .find((block): block is AgentToolResultBlock => block.type === 'toolResult')
    expect(card).toMatchObject({ status: 'succeeded', toolName: 'editImage' })
  })
})

describe('唤醒轮接着提交那一轮的改图计划', () => {
  const masked = (imageId: string) => ({ imageId, dataUrl: PIXEL, maskDataUrl: MASK })
  const bindings = (imageId: string) => [{ imageId, selectionId: SELECTION_ID }]

  it('refuses to resubmit a failed masked edit or add a new one in the wake turn', async () => {
    const edit = {
      prompt: '把圈里的杯子换成蓝色',
      imageIds: ['target'],
      selectionBindings: bindings('target'),
    }
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion({ id: 'edit-1', name: 'editImage', args: edit }),
        // 唤醒轮：候选失败了，模型想原样再拟一次稿，又想顺手追加一个不在计划里的改法。
        () =>
          toolCallCompletion(
            { id: 'same-again', name: 'editImage', args: { ...edit, prompt: '再试一次' } },
            {
              id: 'something-else',
              name: 'editImage',
              args: { ...edit, requestQuote: '杯子换成蓝色' },
            },
          ),
        () => completionStream('这次没改成，要不要换个说法再试？'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '把圈里的杯子换成蓝色', [masked('target')])
    await confirmDrafts(conversationId)
    const [task] = await tasksOf(conversationId)

    await work(task!.id, 'failed')
    expect(await pickUpStrandedInboxes()).toBe(1)
    await waitForTurns(conversationId, 2)

    // 两次都被计划挡下：唤醒轮连稿都没拟出来，也就没有第二条任务。
    expect(await confirmDrafts(conversationId)).toEqual([])
    expect(await tasksOf(conversationId)).toHaveLength(1)
    expect(calls).toHaveLength(3)
    const refusals = JSON.stringify(calls[2]!.messages)
    expect(refusals).toContain('这个编辑操作已经拟过稿，请先检查候选；不要自行重复拟稿')
    expect(refusals).toContain(
      '本轮编辑计划已经执行，不能自行追加生成；请检查已有候选并等待用户指示',
    )
  })

  it('runs a two-step chain of predeclared dependent edits across two wake turns', async () => {
    const userText = '先修改 A，再以 A 的产物为参考修改 B，最后以 B 的产物为参考修改 C'
    const second = {
      targetImageId: 'b',
      selectionId: SELECTION_ID,
      requestQuote: '再以 A 的产物为参考修改 B',
    }
    const third = {
      targetImageId: 'c',
      selectionId: SELECTION_ID,
      requestQuote: '最后以 B 的产物为参考修改 C',
    }
    const produced: string[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion({
            id: 'first',
            name: 'editImage',
            args: {
              prompt: '第一步',
              imageIds: ['a'],
              selectionBindings: bindings('a'),
              requestQuote: '先修改 A',
              deferredEdits: [second, third],
            },
          }),
        // 第一次唤醒：A 的产物出来了，接着拟 B 的稿。
        () =>
          toolCallCompletion({
            id: 'second',
            name: 'editImage',
            args: {
              prompt: '第二步',
              imageIds: ['b', produced[0]!],
              selectionBindings: bindings('b'),
              requestQuote: second.requestQuote,
            },
          }),
        // 第二次唤醒：拟 C 的是唤醒轮，授权原文仍是用户最初那句。
        () =>
          toolCallCompletion({
            id: 'third',
            name: 'editImage',
            args: {
              prompt: '第三步',
              imageIds: ['c', produced[1]!],
              selectionBindings: bindings('c'),
              requestQuote: third.requestQuote,
            },
          }),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, userText, ['a', 'b', 'c'].map(masked))
    await confirmDrafts(conversationId)

    const [a] = await tasksOf(conversationId)
    produced.push(projectArtifactId(a!.id, 0))
    await work(a!.id, 'completed')
    expect(await pickUpStrandedInboxes()).toBe(1)
    await waitForTurns(conversationId, 2)
    // 唤醒轮同样只拟稿：确认之后 B 才交出去，计划随草稿冻结，授权原文还是预先列明的那一句。
    expect(await confirmDrafts(conversationId)).toHaveLength(1)
    const [, b] = await tasksOf(conversationId)
    expect(b!.request_payload.prompt).toContain(second.requestQuote)

    produced.push(projectArtifactId(b!.id, 0))
    await work(b!.id, 'completed')
    expect(await pickUpStrandedInboxes()).toBe(1)
    await waitForTurns(conversationId, 3)
    expect(await confirmDrafts(conversationId)).toHaveLength(1)
    const tasks = await tasksOf(conversationId)
    expect(tasks).toHaveLength(3)
    expect(tasks[2]!.request_payload.prompt).toContain(third.requestQuote)
  })
})

describe('滚动发布', () => {
  it('leaves the wake to other instances while this one drains', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion(generate('call-1')),
        () => completionStream('这张没出来'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    await confirmDrafts(conversationId)
    const [task] = await tasksOf(conversationId)
    await work(task!.id, 'failed')

    // 下线中的实例不再开新轮（放在文件最后：下线不可撤回）。
    bffDrain.begin()
    expect(await pickUpStrandedInboxes()).toBe(0)
    const [wake] = await wakes(conversationId)
    expect(wake!.status).toBe('pending')
  })
})

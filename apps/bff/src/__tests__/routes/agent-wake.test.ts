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
  controlledCompletion,
  eventsOfType,
  parseFrames,
  readFrames,
  recordingAgentFetch,
  scriptedAgentFetch,
  TEST_IMAGE_CHANNEL,
  TEST_RESULT_PAYLOAD,
  type ToolCallSpec,
  toolCallCompletion,
} from '../helpers/agentStubs'
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
const { finishTask, cancelTasks } = await import('../../db/task-transitions')
const { pickUpStrandedInboxes } = await import('../../lib/agent/inbox-pickup')
const { AGENT_WAKE_BATCH_WAIT_MS } = await import('../../lib/agent/wake')
const { bffDrain } = await import('../../lib/drain')
const { imageSelection } = await import('../../lib/agent/selection-preview')
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)
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
  return db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.agent_conversation_id, conversationId))
    .orderBy(schema.tasks.submitted_at)
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
 * 测试里的迷你 worker：领走一条任务、再用 worker 真正写终态的那个函数把它推到终态——唤醒
 * 判断就发生在这一步的事务里。
 */
async function work(taskId: string, outcome: 'completed' | 'failed', completedAt = Date.now()) {
  await db
    .update(schema.tasks)
    .set({ status: 'in_progress', started_at: completedAt })
    .where(eq(schema.tasks.id, taskId))
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId))
  const finished = await finishTask(
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
        () => completionStream('已开始出图'),
        () => completionStream('这张没出来，要不要换个说法再试？'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    const [task] = await tasksOf(conversationId)

    await work(task!.id, 'failed')
    expect(await wakes(conversationId)).toHaveLength(1)
    expect(await pickUpStrandedInboxes()).toBe(1)
    await waitForTurns(conversationId, 2)

    expect(calls).toHaveLength(3)
    const woken = lastUserInput(calls[2]!)
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
        () => completionStream('已开始出图'),
        () => completionStream('不该有这一轮'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    const [task] = await tasksOf(conversationId)

    await work(task!.id, 'completed')
    expect(await pickUpStrandedInboxes()).toBe(0)
    expect(await wakes(conversationId)).toHaveLength(0)
    expect(calls).toHaveLength(2)
    expect(await turnIds(conversationId)).toHaveLength(1)
  })

  it('wakes the agent on success when it asked to review, and attaches the artifact', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion(generate('call-1', { reviewAfterCompletion: true })),
        () => completionStream('已开始出图，出来后我看一下'),
        () => completionStream('看过了，符合要求'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫，画完帮我检查一下')
    const [task] = await tasksOf(conversationId)

    await work(task!.id, 'completed')
    expect(await pickUpStrandedInboxes()).toBe(1)
    await waitForTurns(conversationId, 2)

    const woken = lastUserInput(calls[2]!)
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
        () => completionStream('两张都开始了'),
        () => completionStream('两张都失败了'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画两只不同的猫')
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
    expect(calls).toHaveLength(3)
    const woken = lastUserInput(calls[2]!)
    expect(woken).toContain('一只橘猫 call-1：失败')
    expect(woken).toContain('一只橘猫 call-2：失败')
  })

  it('wakes with what has ended once the batch waited too long, and again for the straggler', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion(generate('call-1'), generate('call-2')),
        () => completionStream('两张都开始了'),
        () => completionStream('第一张没出来'),
        () => completionStream('第二张也没出来'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画两只不同的猫')
    const [first, second] = await tasksOf(conversationId)

    const endedAt = Date.now()
    await work(first!.id, 'failed', endedAt)
    expect(await pickUpStrandedInboxes(endedAt + AGENT_WAKE_BATCH_WAIT_MS - 1_000)).toBe(0)
    expect(await wakes(conversationId)).toHaveLength(0)

    expect(await pickUpStrandedInboxes(endedAt + AGENT_WAKE_BATCH_WAIT_MS)).toBe(1)
    await waitForTurns(conversationId, 2)
    const [early] = await wakes(conversationId)
    expect(early!.payload).toMatchObject({ taskIds: [first!.id] })
    const firstWake = lastUserInput(calls[2]!)
    expect(firstWake).toContain('一只橘猫 call-1：失败')
    expect(firstWake).not.toContain('call-2')

    await work(second!.id, 'failed')
    expect(await pickUpStrandedInboxes()).toBe(1)
    await waitForTurns(conversationId, 3)
    expect(lastUserInput(calls[3]!)).toContain('一只橘猫 call-2：失败')
    expect(await wakes(conversationId)).toHaveLength(2)
  })

  it('waits for the submitting turn to end before it wakes, then wakes right after it', async () => {
    // 这一轮提交之后还在说话：任务这时失败了，这一轮还可能再提交，不能先唤醒。
    const reply = controlledCompletion()
    const answers = [
      () => toolCallCompletion(generate('call-1')),
      (signal?: AbortSignal) => reply.responseFor(signal),
      () => completionStream('刚才那张失败了'),
    ]
    let at = 0
    setAgentFetchForTesting(recordingAgentFetch(calls, (signal) => answers[at++]!(signal)))
    const conversationId = await startConversation()
    const response = await request(`/api/agent/conversations/${conversationId}/turns`, {
      method: 'POST',
      body: { deviceId: DEVICE, text: '画一只橘猫' },
    })
    await readFrames(response, 3)
    const [task] = await tasksOf(conversationId)
    await work(task!.id, 'failed')
    expect(await wakes(conversationId)).toHaveLength(0)
    expect(await pickUpStrandedInboxes()).toBe(0)

    reply.push('已开始出图')
    reply.finish()
    // 那一轮收尾放手时凑齐了这一批，当场唤醒，不必等巡查。
    await waitForTurns(conversationId, 2)
    expect(await wakes(conversationId)).toHaveLength(1)
    expect(lastUserInput(calls[2]!)).toContain('失败（上游超时）')
  })

  it('does not wake the agent for tasks that were cancelled', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion(generate('call-1')),
        () => completionStream('已开始出图'),
        () => completionStream('不该有这一轮'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    const [task] = await tasksOf(conversationId)

    await cancelTasks(eq(schema.tasks.id, task!.id))
    expect(await pickUpStrandedInboxes()).toBe(0)
    expect(await wakes(conversationId)).toHaveLength(0)
    expect(calls).toHaveLength(2)
  })

  it('keeps a single executor per conversation while an old instance still holds it', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion(generate('call-1')),
        () => completionStream('已开始出图'),
        () => completionStream('这张没出来'),
        () => completionStream('不该有第二个唤醒轮'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
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
    expect(calls).toHaveLength(2)

    // 旧实例收尾放手之后，新旧两个实例同时来接：只有一个起得了轮。
    await db
      .update(schema.agent_executions)
      .set({ state: 'completed' })
      .where(eq(schema.agent_executions.conversation_id, conversationId))
    const started = await Promise.all([pickUpStrandedInboxes(), pickUpStrandedInboxes()])
    expect(started.reduce((sum, one) => sum + one, 0)).toBe(1)
    await waitForTurns(conversationId, 2)
    expect(calls).toHaveLength(3)
    const [wake] = await wakes(conversationId)
    expect(wake!.status).toBe('consumed')
  })
})

describe('局部改图', () => {
  it('returns as soon as the masked edit is submitted and reviews the candidate on wake', async () => {
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
        () => completionStream('已开始改，出来后我检查一下'),
        () => completionStream('检查过了，杯子已经是蓝色'),
      ]),
    )
    const conversationId = await startConversation()
    const frames = await runTurn(conversationId, '把圈里的杯子换成蓝色', [
      { imageId: 'target', dataUrl: PIXEL, maskDataUrl: MASK },
    ])

    // 提交即返回：这一轮收尾时任务还排着，结果卡是「已提交」。
    const [end] = eventsOfType(frames, 'toolEnd')
    expect(end).toMatchObject({ toolName: 'editImage', status: 'submitted' })
    expect(frames.at(-1)?.event).toMatchObject({ type: 'turnEnd', stopReason: 'completed' })
    const [task] = await tasksOf(conversationId)
    expect(task!.status).toBe('queued')
    expect(task!.request_payload.mask).toBeTruthy()

    // 候选出来了：模型没选复核也一定被唤醒，看着候选检查。
    await work(task!.id, 'completed')
    expect(await pickUpStrandedInboxes()).toBe(1)
    await waitForTurns(conversationId, 2)
    const woken = lastUserInput(calls[2]!)
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

describe('滚动发布', () => {
  it('leaves the wake to other instances while this one drains', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion(generate('call-1')),
        () => completionStream('已开始出图'),
        () => completionStream('这张没出来'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    const [task] = await tasksOf(conversationId)
    await work(task!.id, 'failed')

    // 下线中的实例不再开新轮（放在文件最后：下线不可撤回）。
    bffDrain.begin()
    expect(await pickUpStrandedInboxes()).toBe(0)
    const [wake] = await wakes(conversationId)
    expect(wake!.status).toBe('pending')
  })
})

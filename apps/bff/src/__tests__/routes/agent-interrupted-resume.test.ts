import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  type AgentConversationSnapshot,
  type AgentToolResultBlock,
  DEVICE_ID_HEADER,
  projectArtifactId,
} from '@image-playground/shared'
import { and, eq, sql } from 'drizzle-orm'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  type ControlledCompletion,
  completionStream,
  confirmPendingDrafts,
  controlledCompletion,
  scriptedAgentFetch,
  TEST_IMAGE_CHANNEL,
  TEST_RESULT_PAYLOAD,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { waitFor } from '../helpers/upstreamStubs'

process.env.DATABASE_URL = await resetTestDatabase('agent_interrupted_resume_a616')
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
const { finishTask } = await import('../../db/task-transitions')
const { pickUpStrandedInboxes } = await import('../../lib/agent/inbox-pickup')
const { runningTurn } = await import('../../lib/agent/runningTurns')
const { AGENT_EXECUTION_LEASE_MS } = await import('../../lib/agent/execution')
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const RESUME_NOTICE = '上一轮回复被服务重启打断了'

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

/** 发一句话开一轮，不跟着流读：轮独立于连接存活。 */
async function send(conversationId: string, text: string): Promise<void> {
  const response = await request(`/api/agent/conversations/${conversationId}/turns`, {
    method: 'POST',
    body: { deviceId: DEVICE, text },
  })
  if (!response.ok) throw new Error(`turn returned ${response.status}: ${await response.text()}`)
  await response.body?.cancel()
}

async function snapshot(conversationId: string): Promise<AgentConversationSnapshot> {
  return (await (
    await request(`/api/agent/conversations/${conversationId}/messages`)
  ).json()) as AgentConversationSnapshot
}

async function turnRows(conversationId: string) {
  return db
    .select()
    .from(schema.agent_turns)
    .where(eq(schema.agent_turns.conversation_id, conversationId))
    .orderBy(schema.agent_turns.created_at)
}

async function leased(conversationId: string): Promise<boolean> {
  const [row] = await db
    .select({ state: schema.agent_executions.state })
    .from(schema.agent_executions)
    .where(eq(schema.agent_executions.conversation_id, conversationId))
  return row?.state === 'running'
}

/** 等续跑那一轮收尾：它的页脚落库、租约放手。 */
async function waitForTurns(conversationId: string, count: number): Promise<void> {
  await waitFor(async () => (await turnRows(conversationId)).length >= count, 5_000)
  await waitFor(async () => !(await leased(conversationId)), 5_000)
}

async function resumes(conversationId: string) {
  return db
    .select()
    .from(schema.agent_inbox)
    .where(
      and(
        eq(schema.agent_inbox.conversation_id, conversationId),
        eq(schema.agent_inbox.kind, 'system_event'),
      ),
    )
}

async function tasksOf(conversationId: string) {
  return db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.agent_conversation_id, conversationId))
}

async function jobsOf(conversationId: string) {
  return db
    .select()
    .from(schema.agent_jobs)
    .where(eq(schema.agent_jobs.conversation_id, conversationId))
}

/** 这次调用落库的结果卡：工具一跑完它就在，用户此刻就能在卡上按确认。 */
async function cardOf(conversationId: string, toolCallId: string) {
  const [row] = await db
    .select({ id: schema.agent_messages.id, content: schema.agent_messages.content })
    .from(schema.agent_messages)
    .where(
      and(
        eq(schema.agent_messages.conversation_id, conversationId),
        sql`${schema.agent_messages.content}->0->>'toolCallId' = ${toolCallId}`,
      ),
    )
  return row ? { id: row.id, block: row.content[0] as AgentToolResultBlock } : undefined
}

/**
 * 等这次调用的卡落定：卡片与它的事件都落了库——进程此刻死掉，续播的客户端与刷新回来的用户
 * 看到的是同一张卡，补写也认得出这一轮做到哪儿了。
 */
async function waitForCard(conversationId: string, toolCallId: string) {
  await waitFor(async () => {
    const [event] = await db
      .select({ seq: schema.agent_turn_events.seq })
      .from(schema.agent_turn_events)
      .where(
        and(
          eq(schema.agent_turn_events.conversation_id, conversationId),
          sql`${schema.agent_turn_events.event}->>'toolCallId' = ${toolCallId}`,
          sql`${schema.agent_turn_events.event}->>'type' = 'toolEnd'`,
        ),
      )
    return event !== undefined && (await cardOf(conversationId, toolCallId)) !== undefined
  }, 3_000)
  return (await cardOf(conversationId, toolCallId))!
}

/** 这几个字已经作为事件落了库：进程此刻死掉，续播的客户端也看过它们。 */
async function deltaStored(conversationId: string, delta: string): Promise<boolean> {
  const [row] = await db
    .select({ seq: schema.agent_turn_events.seq })
    .from(schema.agent_turn_events)
    .where(
      and(
        eq(schema.agent_turn_events.conversation_id, conversationId),
        sql`${schema.agent_turn_events.event}->>'delta' = ${delta}`,
      ),
    )
  return row !== undefined
}

/** 执行者没了：执行租约被接管（心跳过期、归了一个已经不在的实例）。 */
async function abandonExecution(conversationId: string): Promise<void> {
  await db
    .update(schema.agent_executions)
    .set({ instance: 'crashed-instance', heartbeat_at: Date.now() - 2 * AGENT_EXECUTION_LEASE_MS })
    .where(eq(schema.agent_executions.conversation_id, conversationId))
}

/** 与确认端点自己那把卡片锁不在一个号段：这一把只用来把第二次拟稿按住。 */
const DRAFT_STALL_LOCK = 8_731_042

/**
 * 把 `call-2` 那次调用按在草稿落库那一步，放手时这一笔再也写不下去：测试握着这把咨询锁的
 * 这段时间里，第一张卡已经落库（用户看得见、也确认得了），而这一轮还在准备第二张——进程正是
 * 死在这里，准备了一半的那次调用什么也没留下。
 */
async function holdSecondDraft(): Promise<() => Promise<void>> {
  await db.execute(
    sql.raw(`CREATE FUNCTION hold_second_draft() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${DRAFT_STALL_LOCK});
        RAISE EXCEPTION 'the executor died before this draft landed';
      END $$`),
  )
  await db.execute(sql`
    CREATE TRIGGER hold_second_draft BEFORE INSERT ON agent_generation_drafts FOR EACH ROW
    WHEN (NEW.tool_call_id = 'call-2') EXECUTE FUNCTION hold_second_draft()`)
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let acquired!: () => void
  const locked = new Promise<void>((resolve) => {
    acquired = resolve
  })
  const holding = db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SELECT pg_advisory_xact_lock(${DRAFT_STALL_LOCK})`))
    acquired()
    await released
  })
  await locked
  return async () => {
    release()
    await holding
    await db.execute(sql`DROP TRIGGER hold_second_draft ON agent_generation_drafts`)
    await db.execute(sql`DROP FUNCTION hold_second_draft()`)
  }
}

/**
 * 回复说到一半，执行者没了：已经流出去的那几个字落了事件，执行租约被接管。这边的轮再想落库
 * 就发现租约丢了，只能撒手——和进程被杀时留下的一样：没有终帧、没有页脚、租约还标着在跑。
 */
async function crashMidReply(
  conversationId: string,
  upstream: ControlledCompletion,
  partial: string,
): Promise<void> {
  upstream.push(partial)
  await waitFor(() => deltaStored(conversationId, partial), 3_000)
  await abandonExecution(conversationId)
  upstream.push('，剩下的这半句永远不会落库')
  upstream.finish()
  await waitFor(async () => runningTurn(conversationId) === undefined, 3_000)
}

/** 某一轮落库的终帧。 */
async function turnEndOf(conversationId: string, turnId: string) {
  const [row] = await db
    .select({ event: schema.agent_turn_events.event })
    .from(schema.agent_turn_events)
    .where(
      and(
        eq(schema.agent_turn_events.conversation_id, conversationId),
        eq(schema.agent_turn_events.turn_id, turnId),
        sql`${schema.agent_turn_events.event}->>'type' = 'turnEnd'`,
      ),
    )
  return row?.event
}

/** 测试里的迷你 worker：用 worker 真正写终态的那个函数把任务推到成功，唤醒判断就在这一步。 */
async function completeTask(taskId: string): Promise<void> {
  await db
    .update(schema.tasks)
    .set({ status: 'in_progress', started_at: Date.now() })
    .where(eq(schema.tasks.id, taskId))
  expect(
    await finishTask(taskId, {
      status: 'completed',
      completedAt: Date.now(),
      resultPayload: TEST_RESULT_PAYLOAD,
    }),
  ).toBe(true)
}

function lastUserInput(call: AgentCall): string {
  return JSON.stringify(call.messages.filter((message) => message.role === 'user').at(-1))
}

function assistantText(snap: AgentConversationSnapshot): string {
  return JSON.stringify(snap.messages.filter((message) => message.role === 'assistant'))
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

describe('中断续跑', () => {
  it('resumes an interrupted reply once, and a refresh then shows the complete reply', async () => {
    const interrupted = controlledCompletion()
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => interrupted.responseFor(),
        () => completionStream('橘猫已经画好构图，接下来我给它加上阳光。'),
      ]),
    )
    const conversationId = await startConversation()
    await send(conversationId, '画一只橘猫')
    await crashMidReply(conversationId, interrupted, '好的，我先')

    // 用户刷新：快照补上被打断那一轮的终帧，并当场续跑。
    await snapshot(conversationId)
    await waitForTurns(conversationId, 2)

    expect(calls).toHaveLength(2)
    // 续跑的那一轮知道上一轮被打断了，模型输入里也没有那段没说完的话。
    expect(lastUserInput(calls[1]!)).toContain(RESUME_NOTICE)
    expect(JSON.stringify(calls[1]!.messages)).not.toContain('好的，我先')

    const refreshed = await snapshot(conversationId)
    expect(refreshed.activeTurn).toBeNull()
    // 续跑不落用户消息：历史里只有用户那一句，没说完的半截回复丢掉了，续上的是完整的一段。
    expect(refreshed.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(assistantText(refreshed)).not.toContain('好的，我先')
    expect(JSON.stringify(refreshed.messages.at(-1))).toContain('接下来我给它加上阳光')
    const [first, second] = await turnRows(conversationId)
    expect(first!.stop_reason).toBe('failed')
    expect(second!.stop_reason).toBe('completed')
    // 被打断那一轮按「已中断」收尾，不是「失败」：续播的终帧与刷新后的页脚都带这个错误码。
    expect(await turnEndOf(conversationId, first!.turn_id)).toMatchObject({
      stopReason: 'failed',
      error: 'agent_turn_interrupted',
    })
    expect(refreshed.turns.find((one) => one.turnId === first!.turn_id)).toMatchObject({
      stopReason: 'failed',
      error: 'agent_turn_interrupted',
    })
    expect(refreshed.turns.find((one) => one.turnId === second!.turn_id)?.error).toBeUndefined()
  })

  it('resumes the same turn only once, even when the resumed turn is interrupted too', async () => {
    const interrupted = controlledCompletion()
    const resumedToo = controlledCompletion()
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => interrupted.responseFor(),
        () => resumedToo.responseFor(),
        () => completionStream('不该有第三次模型调用'),
      ]),
    )
    const conversationId = await startConversation()
    await send(conversationId, '画一只橘猫')
    await crashMidReply(conversationId, interrupted, '好的，我先')

    // 两个实例同时巡查接手：只续一次。
    const started = await Promise.all([pickUpStrandedInboxes(), pickUpStrandedInboxes()])
    expect(started.reduce((sum, one) => sum + one, 0)).toBe(1)
    await waitFor(async () => calls.length === 2, 3_000)
    expect(lastUserInput(calls[1]!)).toContain(RESUME_NOTICE)

    // 续跑那一轮自己也被打断：补上终帧，但不再续。
    await crashMidReply(conversationId, resumedToo, '接着来')
    expect(await pickUpStrandedInboxes()).toBe(0)
    await waitFor(async () => !(await leased(conversationId)), 3_000)
    // 之后的刷新与巡查也不会再续。
    await snapshot(conversationId)
    expect(await pickUpStrandedInboxes()).toBe(0)

    expect(calls).toHaveLength(2)
    expect(await resumes(conversationId)).toHaveLength(1)
    const rows = await turnRows(conversationId)
    expect(rows.map((row) => row.stop_reason)).toEqual(['failed', 'failed'])
    // 没再续的那一轮是真的失败了：界面照失败报。
    expect(await turnEndOf(conversationId, rows[1]!.turn_id)).toMatchObject({
      error: 'agent_run_failed',
    })
    const footers = (await snapshot(conversationId)).turns
    expect(footers.map((one) => one.error)).toEqual(['agent_turn_interrupted', undefined])
  })

  it('does not resubmit a job confirmed on the interrupted turn, and keeps its submitted card', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion(
            { id: 'call-1', name: 'generateImage', args: { prompt: '一只橘猫' } },
            { id: 'call-2', name: 'generateImage', args: { prompt: '再来一版橘猫' } },
          ),
        // 续跑那一轮的模型没理会提示，把同一张图又要了一次：服务端按幂等键交回原来那个任务。
        () =>
          toolCallCompletion({ id: 'call-3', name: 'generateImage', args: { prompt: '一只橘猫' } }),
        () => completionStream('图还在后台出，出来后会放到画布上。'),
      ]),
    )
    const conversationId = await startConversation()
    const release = await holdSecondDraft()
    try {
      await send(conversationId, '画一只橘猫')
      await waitForCard(conversationId, 'call-1')
      // 用户在这一轮还跑着的时候按下了确认：任务与后台登记都记在这一轮名下。
      expect(await tasksOf(conversationId)).toEqual([])
      const [confirmed] = await confirmPendingDrafts(app, conversationId, { deviceId: DEVICE })
      expect(confirmed).toMatchObject({ status: 'submitted', prompt: '一只橘猫' })
      // 确认之后执行者就没了：这一轮再想落库就发现租约丢了。
      await abandonExecution(conversationId)
    } finally {
      await release()
    }
    await waitFor(async () => runningTurn(conversationId) === undefined, 3_000)
    const [task] = await tasksOf(conversationId)
    expect(task).toBeDefined()
    const submitted = (await cardOf(conversationId, 'call-1'))!

    expect(await pickUpStrandedInboxes()).toBe(1)
    await waitForTurns(conversationId, 2)

    // 续跑那一轮看得到这次调用已经提交过、结果还没出来。
    expect(calls).toHaveLength(3)
    expect(lastUserInput(calls[1]!)).toContain(RESUME_NOTICE)
    expect(JSON.stringify(calls[1]!.messages)).toContain('一只橘猫：已提交后台任务，结果尚未就绪')
    // 它还是再要了一次：没有再提交，任务还是那一个，交回的就是它。
    expect(await tasksOf(conversationId)).toHaveLength(1)
    expect(JSON.stringify(calls[2]!.messages)).toContain('没有重复提交')
    const replayed = (await snapshot(conversationId)).messages
      .flatMap((message) => message.content)
      .find((block) => block.type === 'toolResult' && block.toolCallId === 'call-3')
    expect(replayed).toMatchObject({ status: 'submitted', job: { taskId: task!.id } })

    // 确认过的那张卡原样留着——补写不会拿起跑时的快照把它盖回待确认——任务结束后照常结算、落到画布。
    const card = (await snapshot(conversationId)).messages.find(
      (message) => message.id === submitted.id,
    )
    const block = card?.content[0] as AgentToolResultBlock | undefined
    expect(block).toMatchObject({
      type: 'toolResult',
      toolCallId: 'call-1',
      status: 'submitted',
      prompt: '一只橘猫',
      job: { taskId: task!.id, media: 'image' },
    })
    // 后台登记也只有确认出来的那一条：续跑没有再交一次。
    expect(await jobsOf(conversationId)).toHaveLength(1)
    await db
      .update(schema.tasks)
      .set({ status: 'in_progress', started_at: Date.now() })
      .where(eq(schema.tasks.id, task!.id))
    expect(
      await finishTask(task!.id, {
        status: 'completed',
        completedAt: Date.now(),
        resultPayload: TEST_RESULT_PAYLOAD,
      }),
    ).toBe(true)
    const settled = (await snapshot(conversationId)).messages.find(
      (message) => message.id === submitted.id,
    )
    expect(settled?.content[0]).toMatchObject({ status: 'succeeded' })
  })

  it('resumes an interrupted wake turn with that batch, not the original request', async () => {
    const interruptedWake = controlledCompletion()
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion({
            id: 'call-1',
            name: 'generateImage',
            args: { prompt: '一只橘猫', reviewAfterCompletion: true },
          }),
        () => interruptedWake.responseFor(),
        () => completionStream('看过了，橘猫符合要求'),
      ]),
    )
    const conversationId = await startConversation()
    await send(conversationId, '画一只橘猫，画完帮我检查一下')
    await waitForTurns(conversationId, 1)
    // 拟稿那一轮不建任务：用户在卡上确认之后才有得等。
    expect(await tasksOf(conversationId)).toEqual([])
    await confirmPendingDrafts(app, conversationId, { deviceId: DEVICE })
    const [task] = await tasksOf(conversationId)
    expect(task).toBeDefined()

    // 任务成功，唤醒轮起来复核，说到一半执行者没了。
    await completeTask(task!.id)
    expect(await pickUpStrandedInboxes()).toBe(1)
    await waitFor(async () => calls.length === 2, 3_000)
    await crashMidReply(conversationId, interruptedWake, '我来看看')

    expect(await pickUpStrandedInboxes()).toBe(1)
    await waitForTurns(conversationId, 3)

    expect(calls).toHaveLength(3)
    const resumed = lastUserInput(calls[2]!)
    expect(resumed).toContain(RESUME_NOTICE)
    // 接着处理的是那一批结果：唤醒说明与要复核的产物都在，不是让它把用户最早的请求再做一遍。
    expect(resumed).toContain('你之前提交的后台任务有结果了')
    expect(resumed).not.toContain('请接着把用户上一轮的请求做完')
    const artifactId = projectArtifactId(task!.id, 0)
    expect(resumed).toContain(`视觉输入 1：图片 ${artifactId} 原图`)
    expect(resumed).toContain(`data:image/png;base64,${TEST_RESULT_PAYLOAD.data[0]!.b64_json}`)
    expect(await tasksOf(conversationId)).toHaveLength(1)
    const [resume] = await resumes(conversationId)
    expect(resume!.payload).toMatchObject({ wake: { taskIds: [task!.id] } })
  })

  it('writes the footer and the resume together, so a failure between them loses neither', async () => {
    const interrupted = controlledCompletion()
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => interrupted.responseFor(),
        () => completionStream('橘猫已经画好构图，接下来我给它加上阳光。'),
      ]),
    )
    const conversationId = await startConversation()
    await send(conversationId, '画一只橘猫')
    await crashMidReply(conversationId, interrupted, '好的，我先')

    // 排续跑这一步失败（进程死在这里也一样）：页脚不能先落下，否则这一轮再也没人补、续跑就丢了。
    await db.execute(sql`
      CREATE FUNCTION refuse_resume() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'resume refused for test'; END $$`)
    await db.execute(sql`
      CREATE TRIGGER refuse_resume BEFORE INSERT ON agent_inbox FOR EACH ROW
      WHEN (NEW.kind = 'system_event') EXECUTE FUNCTION refuse_resume()`)
    try {
      await pickUpStrandedInboxes()
    } finally {
      await db.execute(sql`DROP TRIGGER refuse_resume ON agent_inbox`)
      await db.execute(sql`DROP FUNCTION refuse_resume()`)
    }
    expect(await turnRows(conversationId)).toHaveLength(0)
    expect(await resumes(conversationId)).toHaveLength(0)

    // 下一次补写（这里是用户刷新）从头再来：页脚与续跑一起落下，续跑照常跑完。
    await snapshot(conversationId)
    await waitForTurns(conversationId, 2)
    expect(calls).toHaveLength(2)
    expect(lastUserInput(calls[1]!)).toContain(RESUME_NOTICE)
    expect(await resumes(conversationId)).toHaveLength(1)
  })
})

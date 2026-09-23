import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { DEVICE_ID_HEADER } from '@image-playground/shared'
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
import { silenceChatUpstream } from '../helpers/chatStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'
import { waitFor } from '../helpers/upstreamStubs'

// A rollout stops old executors after a finite drain deadline (ADR 0009, superseded in part).
// This file proves what the forced stop relies on: a billed agent turn cut off while a generation
// job confirmed earlier is already at the upstream is recovered without a second upstream
// submission and without a second settlement of anything. The job exists only because the user
// confirmed the drafted prompt — a turn no longer submits anything by itself.

process.env.DATABASE_URL = await resetTestDatabase('bff_forced_stop_recovery')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-billing-operator-config.json')

const billing = installRecordingTaskHooks()

const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { _setPrivateBffOverlayForTesting } = await import('../../lib/private-overlay')
const { close: closeDb, db, schema } = await import('../../db/client')
const { finishTask } = await import('../../db/task-transitions')
const { recoverAbandonedTasks } = await import('../../db/maintenance')
const { pickUpStrandedInboxes } = await import('../../lib/agent/inbox-pickup')
const { runningTurn } = await import('../../lib/agent/runningTurns')
const { AGENT_EXECUTION_LEASE_MS } = await import('../../lib/agent/execution')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')

await silenceChatUpstream()

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const USER_ID = 'forced-stop-user'
const UPSTREAM_JOB_ID = 'upstream-job-submitted-before-stop'
let sessionToken = ''
let calls: AgentCall[]

function request(path: string, init: { method?: string; body?: unknown } = {}) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        [DEVICE_ID_HEADER]: DEVICE,
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
  return ((await response.json()) as { conversation: { id: string } }).conversation.id
}

async function send(conversationId: string, text: string): Promise<void> {
  const response = await request(`/api/agent/conversations/${conversationId}/turns`, {
    method: 'POST',
    body: { deviceId: DEVICE, text },
  })
  if (!response.ok) throw new Error(`turn returned ${response.status}: ${await response.text()}`)
  await response.body?.cancel()
}

async function tasksOf(conversationId: string) {
  return db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.agent_conversation_id, conversationId))
}

async function leased(conversationId: string): Promise<boolean> {
  const [row] = await db
    .select({ state: schema.agent_executions.state })
    .from(schema.agent_executions)
    .where(eq(schema.agent_executions.conversation_id, conversationId))
  return row?.state === 'running'
}

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

/**
 * `docker stop` after the drain deadline: the BFF process and the worker polling the job are both
 * gone. Nothing renews their leases any more, so once the lease window has passed the database
 * holds exactly this: a running conversation execution with a stale heartbeat, a chat task and a
 * job task whose leases have expired, and a job that already carries its upstream task id.
 */
async function forceStopBothExecutors(
  conversationId: string,
  upstream: ControlledCompletion,
  jobId: string,
): Promise<void> {
  upstream.push('图已经在出')
  await waitFor(() => deltaStored(conversationId, '图已经在出'), 3_000)
  const expired = Date.now() - 2 * AGENT_EXECUTION_LEASE_MS
  await db
    .update(schema.agent_executions)
    .set({ instance: 'stopped-bff', heartbeat_at: expired })
    .where(eq(schema.agent_executions.conversation_id, conversationId))
  await db
    .update(schema.tasks)
    .set({ lease_expires_at: expired })
    .where(
      and(
        eq(schema.tasks.agent_conversation_id, conversationId),
        eq(schema.tasks.kind, 'chat'),
        eq(schema.tasks.status, 'in_progress'),
      ),
    )
  await db
    .update(schema.tasks)
    .set({
      status: 'in_progress',
      started_at: expired,
      execution_token: 'stopped-worker',
      lease_expires_at: expired,
      upstream_task_ids: [UPSTREAM_JOB_ID],
      upstream_submitted_at: expired,
      upstream_invocation_count: 1,
    })
    .where(eq(schema.tasks.id, jobId))
  // The in-process stand-in for the stopped BFF finds its ownership gone and writes nothing more.
  upstream.push('，这半句永远不会落库')
  upstream.finish()
  await waitFor(async () => runningTurn(conversationId) === undefined, 3_000)
}

function settlementsOf(taskId: string) {
  return billing.settlements.filter((one) => one.taskId === taskId)
}

beforeEach(async () => {
  billing.reset()
  _setChannelsForTesting([TEST_IMAGE_CHANNEL])
  setObjectStoreForTesting(new InMemoryObjectStore())
  await db.delete(schema.tasks)
  await db.delete(schema.agent_conversations)
  await db.delete(schema.agent_executions)
  await db.delete(schema.user_sessions)
  await db.delete(schema.users)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: USER_ID,
    username: 'forced.stop',
    password_hash: 'hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  sessionToken = await db.transaction((tx) => createUserSession(USER_ID, tx))
  calls = []
})

afterEach(() => {
  setAgentFetchForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  _setPrivateBffOverlayForTesting()
  await closeDb()
})

describe('forced stop after the drain deadline', () => {
  const recoveryOrders = [
    ['the worker scan runs before the BFF pickup', true],
    ['the BFF pickup runs before the worker scan', false],
  ] as const
  it.each(
    recoveryOrders,
  )('recovers a billed turn stopped while a confirmed job was at the upstream without resubmitting or settling twice when %s', async (_order, workerFirst) => {
    const interrupted = controlledCompletion()
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion({ id: 'call-1', name: 'generateImage', args: { prompt: '一只橘猫' } }),
        () => interrupted.responseFor(),
        () => completionStream('图还在后台出，出来后会放到画布上。'),
      ]),
    )
    const conversationId = await startConversation()
    // 第一轮只拟稿：这一刻还没有生成任务，也没有为它预扣。
    await send(conversationId, '画一只橘猫')
    await waitFor(async () => calls.length === 1, 3_000)
    // 拟完稿这一轮就收尾了，卡片这时才落库。
    await waitFor(async () => runningTurn(conversationId) === undefined, 5_000)
    expect((await tasksOf(conversationId)).filter((task) => task.kind !== 'chat')).toEqual([])
    // 用户确认，任务这才建出来，挂在拟稿那一轮下面。
    const [confirmed] = await confirmPendingDrafts(app, conversationId, {
      deviceId: DEVICE,
      cookie: `${USER_SESSION_COOKIE}=${sessionToken}`,
    })
    const jobId = confirmed?.job?.taskId
    expect(jobId).toBeTruthy()
    // 第二轮说到一半被停掉：它是被计费的那一轮，任务此刻已经在上游跑着。
    await send(conversationId, '出得怎么样了')
    await waitFor(async () => calls.length === 2, 3_000)
    const [interruptedChat] = (await tasksOf(conversationId)).filter(
      (task) => task.kind === 'chat' && task.status === 'in_progress',
    )
    expect(interruptedChat).toBeDefined()

    await forceStopBothExecutors(conversationId, interrupted, jobId!)

    // The replacement generation's worker scan and BFF pickup run, twice each, as their timers do.
    if (workerFirst) await recoverAbandonedTasks()
    expect(await pickUpStrandedInboxes()).toBe(1)
    await waitFor(async () => calls.length === 3, 5_000)
    await waitFor(async () => !(await leased(conversationId)), 5_000)
    await recoverAbandonedTasks()
    expect(await pickUpStrandedInboxes()).toBe(0)

    const tasks = await tasksOf(conversationId)
    const jobs = tasks.filter((task) => task.kind !== 'chat')
    // One job, never resubmitted: it goes back to polling the id it already had.
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      id: jobId,
      status: 'queued',
      upstream_task_ids: [UPSTREAM_JOB_ID],
      upstream_invocation_count: 1,
    })
    expect(settlementsOf(jobId!)).toHaveLength(0)

    // 被停掉那一轮的预扣只退一次，续跑那一轮只计费一次；三条对话任务是拟稿轮、被停轮与续跑轮。
    const chats = tasks.filter((task) => task.kind === 'chat')
    expect(chats).toHaveLength(3)
    expect(settlementsOf(interruptedChat!.id)).toEqual([
      expect.objectContaining({ outcome: 'failed' }),
    ])
    const resumedChat = chats.find(
      (task) =>
        task.submitted_at > interruptedChat!.submitted_at && task.id !== interruptedChat!.id,
    )
    expect(settlementsOf(resumedChat!.id)).toEqual([
      expect.objectContaining({ outcome: 'completed' }),
    ])
    // 每条任务都只预扣一次：三轮对话，加上用户确认时建出来的那条生成任务。
    expect(billing.reservations.map((one) => one.taskId).sort()).toEqual(
      [...chats.map((task) => task.id), jobId!].sort(),
    )

    // The new worker finishes polling the stored id; the job settles once, and later scans by
    // either generation add nothing.
    await db
      .update(schema.tasks)
      .set({ status: 'in_progress', started_at: Date.now(), execution_token: 'new-worker' })
      .where(eq(schema.tasks.id, jobId!))
    expect(
      await finishTask(jobId!, {
        status: 'completed',
        completedAt: Date.now(),
        resultPayload: TEST_RESULT_PAYLOAD,
      }),
    ).toBe(true)
    await recoverAbandonedTasks()
    await pickUpStrandedInboxes()
    await waitFor(async () => !(await leased(conversationId)), 5_000)
    expect(settlementsOf(jobId!)).toEqual([expect.objectContaining({ outcome: 'completed' })])
    expect(settlementsOf(interruptedChat!.id)).toHaveLength(1)
    expect(settlementsOf(resumedChat!.id)).toHaveLength(1)
  })
})

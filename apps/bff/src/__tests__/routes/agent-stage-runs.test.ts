import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentTurnParams, StageAuthorization } from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import {
  type AgentCall,
  completionStream,
  scriptedAgentFetch,
  TEST_IMAGE_CHANNEL,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { waitFor } from '../helpers/upstreamStubs'

process.env.DATABASE_URL = await resetTestDatabase('agent_stage_runs_1367')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../stage-run-operator-config.json')

const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)
type Reservation =
  | { kind: 'reserved'; credits: number }
  | { kind: 'insufficient_credits'; required: number; available: number }
let reservation: Reservation = { kind: 'reserved', credits: 0 }
/** 任务实际结算的积分；失败任务退回时是 0。 */
const settled = new Map<string, number>()
_setPrivateBffOverlayForTesting({
  ...EMPTY_PRIVATE_BFF_OVERLAY,
  present: true,
  taskHooks: {
    ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks,
    async quoteTask({ model, quantity, unitMultiplier }) {
      return {
        estimatedCredits: 6 * quantity * unitMultiplier,
        pricing: {
          model,
          quantity,
          unitMultiplier,
          unit: 'image',
          pricingVersion: 'fixture',
          quotedAt: Date.now(),
          validUntil: null,
          baseUnitCredits: 6,
          outputPriceRatio: 0,
          cachedInputPriceRatio: 0,
          inputEstimateTokens: 0,
          outputReserveTokens: 0,
          exemption: 'none',
        },
      }
    },
    async reserveTask() {
      return reservation
    },
    async finalizeTask() {},
    async taskCredits({ taskIds }) {
      return Object.fromEntries(
        taskIds.filter((id) => settled.has(id)).map((id) => [id, settled.get(id)!]),
      )
    },
    async chatPricing() {
      return null
    },
  },
})

// 模块要在独立库与计费边界装好之后再加载。
const { app } = await import('../../app')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { db, schema, close } = await import('../../db/client')
const { pickUpStrandedInboxes } = await import('../../lib/agent/inbox-pickup')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { createNodes, runNodes } = await import('../../lib/agent/tools/nodeCanvas')
const { createAgentImageSource } = await import('../../lib/agent/images')
const { stageRunWakeContent } = await import('../../lib/agent/stage-runs')

await silenceChatUpstream()

const USER_ID = 'stage-run-owner'
const DEVICE = 'stage-run-device'
let cookie = ''
let calls: AgentCall[] = []

beforeEach(async () => {
  reservation = { kind: 'reserved', credits: 0 }
  settled.clear()
  _setChannelsForTesting([TEST_IMAGE_CHANNEL])
  await db.delete(schema.tasks)
  await db.delete(schema.agent_conversations)
  await db.delete(schema.user_sessions)
  await db.delete(schema.users)
  const now = Date.now()
  for (const id of [USER_ID, 'stage-run-other'])
    await db.insert(schema.users).values({
      id,
      username: id,
      password_hash: 'unused',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession(USER_ID, tx))}`
  calls = []
  setAgentFetchForTesting(scriptedAgentFetch(calls, [() => completionStream('这批跑完了。')]))
})
afterEach(() => setAgentFetchForTesting())
afterAll(async () => {
  _setPrivateBffOverlayForTesting()
  await close()
})

/** 智能体在画布上建两个节点，再为给定节点提出一次阶段授权。 */
async function proposal(nodeIds = ['a', 'b'], params?: AgentTurnParams) {
  const conversationId = crypto.randomUUID(),
    projectId = crypto.randomUUID(),
    now = Date.now()
  await db.insert(schema.agent_conversations).values({
    id: conversationId,
    user_id: USER_ID,
    title: '运行回报',
    created_at: now,
    updated_at: now,
  })
  await db.insert(schema.canvas_projects).values({
    id: projectId,
    user_id: USER_ID,
    conversation_id: conversationId,
    name: '运行回报',
    document: { version: 1, elements: [] },
    revision: 1,
    receipts: [],
    element_count: 0,
    created_at: now,
    updated_at: now,
  })
  const context = {
    mode: 'image' as const,
    experience: 'canvas' as const,
    conversationId,
    turnId: 'proposal-turn',
    deviceId: DEVICE,
    userId: USER_ID,
    canvas: { selectedNodeIds: [], elements: [] },
    images: createAgentImageSource({
      references: [],
      history: [],
      conversationId,
      userId: USER_ID,
    }),
    autoSubmit: {
      take: () => {
        throw new Error('画布不占每轮配额')
      },
    },
    ...(params ? { params } : {}),
  }
  await createNodes.create(context).execute(
    'create',
    {
      nodes: [
        { id: 'a', type: 'image', prompt: '嫩芽' },
        { id: 'b', type: 'image', prompt: '大树' },
      ],
    },
    undefined,
    undefined,
  )
  const result = await runNodes
    .create(context)
    .execute('proposal', { stage: '素材', nodeIds }, undefined, undefined)
  return { conversationId, ...result.details!.canvasRun! }
}

function request(id: string, action = '', body?: unknown, session = cookie) {
  return app.handle(
    new Request(`http://localhost/api/agent/stage-authorizations/${id}${action}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie: session, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

async function confirm(id: string): Promise<string> {
  const response = await request(id, '/confirm', {})
  expect(response.status).toBe(200)
  return ((await response.json()) as { executionToken: string }).executionToken
}

async function stored(id: string): Promise<StageAuthorization> {
  const [row] = await db
    .select({ state: schema.agent_stage_authorizations.state })
    .from(schema.agent_stage_authorizations)
    .where(eq(schema.agent_stage_authorizations.id, id))
  return row!.state
}

/** 把一次尝试记成已提交并以给定状态收场的任务，结算按 `charged` 记。 */
async function submitted(
  id: string,
  attemptId: string,
  taskId: string,
  status: 'failed' | 'completed' | 'in_progress',
  charged: number,
) {
  const state = await stored(id)
  await db.insert(schema.tasks).values({
    id: taskId,
    user_id: USER_ID,
    provider: 'openai-compat',
    model: 'gpt-image-2.5-flare',
    status,
    request_payload: { device_id: DEVICE, prompt: '嫩芽', n: 1 },
    submitted_at: Date.now(),
  })
  settled.set(taskId, charged)
  const spent = state.attempts.find((attempt) => attempt.id === attemptId)!.reservedCredits
  const spentCredits = state.spentCredits + spent
  await db
    .update(schema.agent_stage_authorizations)
    .set({
      state: {
        ...state,
        spentCredits,
        status: spentCredits >= state.budgetCap ? 'exhausted' : state.status,
        attempts: state.attempts.map((attempt) =>
          attempt.id === attemptId
            ? { ...attempt, spentCredits: spent, submittedQuantity: 1, taskIds: [taskId] }
            : attempt,
        ),
      },
    })
    .where(eq(schema.agent_stage_authorizations.id, id))
}

function preflight(id: string, executionToken: string, nodeId: string, attemptId: string) {
  return request(id, '/preflight', {
    nodeId,
    model: 'gpt-image-2.5-flare',
    quantity: 1,
    unitMultiplier: 1,
    executionToken,
    attemptId,
  })
}

async function wakeRows(conversationId: string) {
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

async function settledTurn(conversationId: string) {
  await waitFor(async () => {
    const [row] = await db
      .select({ state: schema.agent_executions.state })
      .from(schema.agent_executions)
      .where(eq(schema.agent_executions.conversation_id, conversationId))
    return row?.state !== 'running'
  }, 3_000)
}

it('wakes the agent once per batch with every node named and its outcome', async () => {
  const run = await proposal()
  const token = await confirm(run.authorizationId)
  expect((await preflight(run.authorizationId, token, 'a', 'a-1')).status).toBe(200)
  await submitted(run.authorizationId, 'a-1', 'task-a', 'completed', 6)
  const report = await request(run.authorizationId, '/report', {
    executionToken: token,
    deviceId: DEVICE,
    nodes: [
      { nodeId: 'a', outcome: 'completed' },
      { nodeId: 'b', outcome: 'blocked', reason: 'missing_media' },
    ],
  })
  expect(report.status).toBe(200)
  expect(await report.json()).toMatchObject({
    wake: 'queued',
    authorization: {
      status: 'ended',
      run: { nodes: [{ outcome: 'completed' }, { outcome: 'blocked' }] },
    },
  })
  expect(await (await request(run.authorizationId, '/wake')).json()).toEqual({ status: 'pending' })

  expect(await pickUpStrandedInboxes()).toBe(1)
  await settledTurn(run.conversationId)
  expect(calls).toHaveLength(1)
  const asked = JSON.stringify(calls[0]!.messages)
  const [first, second] = run.nodeNames!
  expect(asked).toContain(`「${first}」：已完成`)
  expect(asked).toContain(`「${second}」：开跑前被拦下，没有提交：引用的素材没有可用的图`)
  expect(asked).not.toContain('"a"')
  const receipt = await (await request(run.authorizationId, '/wake')).json()
  expect(receipt).toMatchObject({ status: 'consumed', turnId: expect.any(String) })

  // 同一批再报一次：原样交回，不再唤醒。
  const again = await request(run.authorizationId, '/report', {
    executionToken: token,
    nodes: [
      { nodeId: 'a', outcome: 'completed' },
      { nodeId: 'b', outcome: 'blocked', reason: 'missing_media' },
    ],
  })
  expect(await again.json()).toMatchObject({ wake: 'duplicate' })
  expect(await pickUpStrandedInboxes()).toBe(0)
  expect(calls).toHaveLength(1)
  expect(await wakeRows(run.conversationId)).toHaveLength(1)
})

it('wakes for a direct run blocked before confirmation and ends the authorization', async () => {
  const run = await proposal(['a'])
  const report = await request(run.authorizationId, '/report', {
    deviceId: DEVICE,
    nodes: [{ nodeId: 'a', outcome: 'blocked', reason: 'missing_frame' }],
  })
  expect(report.status).toBe(200)
  expect((await stored(run.authorizationId)).status).toBe('ended')
  expect(await pickUpStrandedInboxes()).toBe(1)
  await settledTurn(run.conversationId)
  expect(JSON.stringify(calls[0]!.messages)).toContain('首帧或尾帧帧位为空')
  // 被拦下的一批还没确认就没有执行凭证：确认不了，也提交不了。
  expect((await request(run.authorizationId, '/confirm', {})).status).toBe(409)
})

it('points a first-frame batch back to runStoryboardFrames, not runNodes', async () => {
  const run = await proposal(['a'])
  const state = await stored(run.authorizationId)
  await db
    .update(schema.agent_stage_authorizations)
    .set({ state: { ...state, storyboard: { storyboardId: 'board', fingerprint: 'fp' } } })
    .where(eq(schema.agent_stage_authorizations.id, run.authorizationId))
  const report = await request(run.authorizationId, '/report', {
    deviceId: DEVICE,
    nodes: [{ nodeId: 'a', outcome: 'skipped', reason: 'stopped' }],
  })
  expect(report.status).toBe(200)
  expect(await pickUpStrandedInboxes()).toBe(1)
  await settledTurn(run.conversationId)
  const asked = JSON.stringify(calls[0]!.messages)
  expect(asked).toContain('再用 runStoryboardFrames（单镜重出传 shotIds） 发起新的阶段授权')
  expect(asked).not.toContain('再用 runNodes 发起')
})

/** 唤醒轮里智能体再为节点 a 发起一次 runNodes：返回新授权与它的运行卡。 */
async function wakeRerun(conversationId: string, previousId: string) {
  // 线上项目第一轮就记下了画布入口；这里的提案直接调工具，没有那一轮，补记上。
  await db
    .update(schema.canvas_projects)
    .set({ document: { version: 1, elements: [], experience: 'canvas' } })
    .where(eq(schema.canvas_projects.conversation_id, conversationId))
  setAgentFetchForTesting(
    scriptedAgentFetch(calls, [
      () =>
        toolCallCompletion({
          id: 'wake-rerun',
          name: 'runNodes',
          args: { stage: '素材', nodeIds: ['a'] },
        }),
      () => completionStream('已重新发起。'),
    ]),
  )
  expect(await pickUpStrandedInboxes()).toBe(1)
  await settledTurn(conversationId)
  const rows = await db
    .select({
      id: schema.agent_stage_authorizations.id,
      state: schema.agent_stage_authorizations.state,
    })
    .from(schema.agent_stage_authorizations)
    .where(eq(schema.agent_stage_authorizations.conversation_id, conversationId))
  const rerun = rows.find((row) => row.id !== previousId)?.state
  if (!rerun) throw new Error('wake round did not propose a new authorization')
  const messages = await db
    .select({ content: schema.agent_messages.content })
    .from(schema.agent_messages)
    .where(eq(schema.agent_messages.conversation_id, conversationId))
  const card = messages
    .flatMap((message) => message.content)
    .find((block) => block.type === 'toolResult' && block.canvasRun?.authorizationId === rerun.id)
  if (card?.type !== 'toolResult' || !card.canvasRun) throw new Error('missing rerun card')
  return { rerun, canvasRun: card.canvasRun }
}

const WORKBENCH = { canvasImageModel: 'workbench-image', canvasImageCount: 4 } as const

it('runs a wake-round runNodes directly with the proposing turn workbench model and count', async () => {
  const run = await proposal(['a'], WORKBENCH)
  expect(run.direct).toBe(true)
  expect(run.specs).toEqual([
    { nodeId: 'a', model: 'workbench-image', quantity: 4, unitMultiplier: 1 },
  ])
  const report = await request(run.authorizationId, '/report', {
    deviceId: DEVICE,
    nodes: [{ nodeId: 'a', outcome: 'blocked', reason: 'missing_media' }],
  })
  expect(report.status).toBe(200)
  const { rerun, canvasRun } = await wakeRerun(run.conversationId, run.authorizationId)
  expect(canvasRun.direct).toBe(true)
  // 报价与提案那一轮一致：工作台模型、4 张，原标签页照同一份规格开跑不会判成规格已变化。
  expect(rerun.charges).toMatchObject([
    { nodeId: 'a', model: 'workbench-image', quantity: 4, unitMultiplier: 1 },
  ])
})

it('keeps the confirmation card in the wake round when the proposing turn had auto-submit off', async () => {
  const run = await proposal(['a'], { ...WORKBENCH, autoSubmit: false })
  expect(run.direct).toBe(false)
  const report = await request(run.authorizationId, '/report', {
    deviceId: DEVICE,
    nodes: [{ nodeId: 'a', outcome: 'skipped', reason: 'stopped' }],
  })
  expect(report.status).toBe(200)
  const { rerun, canvasRun } = await wakeRerun(run.conversationId, run.authorizationId)
  expect(canvasRun.direct).toBe(false)
  expect(rerun.status).toBe('pending')
  expect(rerun.charges).toMatchObject([{ model: 'workbench-image', quantity: 4 }])
})

it('falls back to confirmation for authorizations recorded before the turn settings were kept', async () => {
  const run = await proposal(['a'], WORKBENCH)
  const state = await stored(run.authorizationId)
  const { turn: _dropped, ...legacy } = state
  await db
    .update(schema.agent_stage_authorizations)
    .set({ state: legacy })
    .where(eq(schema.agent_stage_authorizations.id, run.authorizationId))
  const report = await request(run.authorizationId, '/report', {
    deviceId: DEVICE,
    nodes: [{ nodeId: 'a', outcome: 'skipped', reason: 'stopped' }],
  })
  expect(report.status).toBe(200)
  const wake = await stageRunWakeContent(
    run.conversationId,
    { kind: 'user', userId: USER_ID },
    { authorizationId: run.authorizationId, eventVersion: 1 },
  )
  expect(wake?.params).toEqual({ autoSubmit: false })
})

it('rejects reports that disagree with what the server recorded', async () => {
  const run = await proposal()
  const token = await confirm(run.authorizationId)
  const report = (body: object) => request(run.authorizationId, '/report', body)
  // 少报一个节点、多报一个节点。
  expect(
    (await report({ executionToken: token, nodes: [{ nodeId: 'a', outcome: 'skipped' }] })).status,
  ).toBe(422)
  // 没提交过却说已完成。
  expect(
    (
      await report({
        executionToken: token,
        nodes: [
          { nodeId: 'a', outcome: 'completed' },
          { nodeId: 'b', outcome: 'skipped' },
        ],
      })
    ).status,
  ).toBe(422)
  // 已确认的授权不带凭证或凭证不对。
  expect(
    (
      await report({
        executionToken: 'forged',
        nodes: [
          { nodeId: 'a', outcome: 'skipped' },
          { nodeId: 'b', outcome: 'skipped' },
        ],
      })
    ).status,
  ).toBe(409)
  expect(await wakeRows(run.conversationId)).toHaveLength(0)
  expect((await request(run.authorizationId, '/wake')).status).toBe(404)
})

it('checks outcomes against the tasks the server holds, not what the browser claims', async () => {
  const run = await proposal()
  const token = await confirm(run.authorizationId)
  // 「a」第一次失败退款、重试后成功；「b」提交了但失败。
  expect((await preflight(run.authorizationId, token, 'a', 'a-1')).status).toBe(200)
  await submitted(run.authorizationId, 'a-1', 'task-a-1', 'failed', 0)
  expect((await preflight(run.authorizationId, token, 'a', 'a-2')).status).toBe(200)
  await submitted(run.authorizationId, 'a-2', 'task-a-2', 'completed', 6)
  expect((await preflight(run.authorizationId, token, 'b', 'b-1')).status).toBe(200)
  await submitted(run.authorizationId, 'b-1', 'task-b-1', 'failed', 6)
  const report = (b: object, a: object = { nodeId: 'a', outcome: 'completed' }) =>
    request(run.authorizationId, '/report', { executionToken: token, nodes: [a, b] })
  // 任务在服务端是失败的，不能报已完成；提交过的也不能报没轮到或被拦下。
  expect((await report({ nodeId: 'b', outcome: 'completed' })).status).toBe(422)
  expect((await report({ nodeId: 'b', outcome: 'skipped', reason: 'stopped' })).status).toBe(422)
  expect((await report({ nodeId: 'b', outcome: 'blocked', reason: 'missing_media' })).status).toBe(
    422,
  )
  expect(await wakeRows(run.conversationId)).toHaveLength(0)
  // 「重试过」按服务端的尝试算：浏览器给反了也照实记。
  const accepted = await report(
    { nodeId: 'b', outcome: 'failed', reason: 'generation_failed', retried: true },
    { nodeId: 'a', outcome: 'completed', retried: false },
  )
  expect(accepted.status).toBe(200)
  expect((await stored(run.authorizationId)).run?.nodes).toEqual([
    { nodeId: 'a', outcome: 'completed', retried: true },
    { nodeId: 'b', outcome: 'failed', reason: 'generation_failed' },
  ])
})

it('marks a reported failure whose task is still running or already succeeded', async () => {
  const run = await proposal()
  const token = await confirm(run.authorizationId)
  expect((await preflight(run.authorizationId, token, 'a', 'a-1')).status).toBe(200)
  await submitted(run.authorizationId, 'a-1', 'task-a-1', 'in_progress', 6)
  expect((await preflight(run.authorizationId, token, 'b', 'b-1')).status).toBe(200)
  await submitted(run.authorizationId, 'b-1', 'task-b-1', 'completed', 6)
  const report = await request(run.authorizationId, '/report', {
    executionToken: token,
    deviceId: DEVICE,
    nodes: [
      { nodeId: 'a', outcome: 'failed', reason: 'canvas_changed' },
      { nodeId: 'b', outcome: 'failed', reason: 'canvas_changed' },
    ],
  })
  expect(report.status).toBe(200)
  expect((await stored(run.authorizationId)).run?.nodes).toEqual([
    { nodeId: 'a', outcome: 'failed', reason: 'canvas_changed', task: 'running' },
    { nodeId: 'b', outcome: 'failed', reason: 'canvas_changed', task: 'completed' },
  ])
  expect(await pickUpStrandedInboxes()).toBe(1)
  await settledTurn(run.conversationId)
  const asked = JSON.stringify(calls[0]!.messages)
  const [first, second] = run.nodeNames!
  expect(asked).toContain(`「${first}」：已提交，任务还在生成`)
  expect(asked).toContain(`「${second}」：已提交，任务出了结果，但没能成为节点主结果`)
  // 不算进失败，也不给失败节点的话术。
  expect(asked).toContain('失败 0，没等到结果 2，')
  expect(asked).not.toContain('失败节点')
})

it('records a failed node that never created a task as blocked', async () => {
  const run = await proposal(['a'])
  const token = await confirm(run.authorizationId)
  expect((await preflight(run.authorizationId, token, 'a', 'a-1')).status).toBe(200)
  const report = await request(run.authorizationId, '/report', {
    executionToken: token,
    nodes: [{ nodeId: 'a', outcome: 'failed', reason: 'authorization' }],
  })
  expect(report.status).toBe(200)
  expect((await stored(run.authorizationId)).run?.nodes).toEqual([
    { nodeId: 'a', outcome: 'blocked', reason: 'authorization' },
  ])
})

it('refuses a report after the user ended the authorization and does not wake', async () => {
  const run = await proposal(['a'])
  const token = await confirm(run.authorizationId)
  expect((await request(run.authorizationId, '/end', {})).status).toBe(200)
  const report = await request(run.authorizationId, '/report', {
    executionToken: token,
    nodes: [{ nodeId: 'a', outcome: 'skipped', reason: 'stopped' }],
  })
  expect(report.status).toBe(409)
  expect(await report.json()).toMatchObject({ error: 'stage_authorization_inactive' })
  expect(await wakeRows(run.conversationId)).toHaveLength(0)
  expect((await stored(run.authorizationId)).run).toBeUndefined()
})

it('retries a failed node once inside the budget when the failed task was refunded', async () => {
  const run = await proposal(['a'])
  const token = await confirm(run.authorizationId)
  expect((await preflight(run.authorizationId, token, 'a', 'a-1')).status).toBe(200)
  await submitted(run.authorizationId, 'a-1', 'task-a-1', 'failed', 0)
  expect((await stored(run.authorizationId)).status).toBe('exhausted')
  // 失败的任务退回了积分：额度还给授权，授权内自动重试一次。
  const retry = await preflight(run.authorizationId, token, 'a', 'a-2')
  expect(retry.status).toBe(200)
  const state = await stored(run.authorizationId)
  expect(state).toMatchObject({ status: 'active', spentCredits: 0 })
  expect(state.audit.at(-1)).toMatchObject({ kind: 'retry', nodeId: 'a' })
  await submitted(run.authorizationId, 'a-2', 'task-a-2', 'failed', 0)
  // 第二次失败不再重试。
  const limit = await preflight(run.authorizationId, token, 'a', 'a-3')
  expect(limit.status).toBe(409)
  expect(await limit.json()).toMatchObject({ error: 'stage_authorization_retry_limit' })
})

it('stops at the budget when the failed attempt was still charged', async () => {
  const run = await proposal(['a'])
  const token = await confirm(run.authorizationId)
  expect((await preflight(run.authorizationId, token, 'a', 'a-1')).status).toBe(200)
  await submitted(run.authorizationId, 'a-1', 'task-a-1', 'failed', 6)
  const retry = await preflight(run.authorizationId, token, 'a', 'a-2')
  expect(retry.status).toBe(409)
  expect(await retry.json()).toMatchObject({ error: 'stage_authorization_budget' })
  expect((await stored(run.authorizationId)).status).toBe('exhausted')
})

it('does not retry a node whose task is still running or succeeded', async () => {
  const run = await proposal(['a'])
  const token = await confirm(run.authorizationId)
  // 预算放宽，单看「已提交」这条规则。
  const state = await stored(run.authorizationId)
  await db
    .update(schema.agent_stage_authorizations)
    .set({ state: { ...state, budgetCap: 60 } })
    .where(eq(schema.agent_stage_authorizations.id, run.authorizationId))
  expect((await preflight(run.authorizationId, token, 'a', 'a-1')).status).toBe(200)
  await submitted(run.authorizationId, 'a-1', 'task-a-1', 'completed', 6)
  const retry = await preflight(run.authorizationId, token, 'a', 'a-2')
  expect(retry.status).toBe(409)
  expect(await retry.json()).toMatchObject({ error: 'stage_authorization_node_already_started' })
})

it('does not wake when credits run out and says why on the run card', async () => {
  const run = await proposal(['a'])
  const token = await confirm(run.authorizationId)
  reservation = { kind: 'insufficient_credits', required: 50, available: 0 }
  await request(run.authorizationId, '/report', {
    executionToken: token,
    deviceId: DEVICE,
    nodes: [{ nodeId: 'a', outcome: 'skipped', reason: 'stopped' }],
  })
  expect(await pickUpStrandedInboxes()).toBe(0)
  expect(calls).toHaveLength(0)
  expect(await (await request(run.authorizationId, '/wake')).json()).toEqual({
    status: 'skipped',
    reason: 'insufficient_credits',
  })
  expect((await stored(run.authorizationId)).run?.wakeSkipped).toBe('insufficient_credits')
  // 充值之后也不补唤醒。
  reservation = { kind: 'reserved', credits: 0 }
  expect(await pickUpStrandedInboxes()).toBe(0)
  expect(calls).toHaveLength(0)
})

it('only the owner can report or read the wake', async () => {
  const run = await proposal(['a'])
  const other = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('stage-run-other', tx))}`
  const body = { nodes: [{ nodeId: 'a', outcome: 'blocked', reason: 'missing_prompt' }] }
  expect((await request(run.authorizationId, '/report', body, other)).status).toBe(404)
  expect((await request(run.authorizationId, '/wake', undefined, other)).status).toBe(404)
  expect((await request(run.authorizationId, '/report', body, '')).status).toBe(401)
})

it('ends the previous account authorizations when another account logs in on this browser', async () => {
  const run = await proposal(['a'])
  await confirm(run.authorizationId)
  await db
    .update(schema.users)
    .set({ password_hash: await Bun.password.hash('other-password', { algorithm: 'argon2id' }) })
    .where(eq(schema.users.id, 'stage-run-other'))
  // 同一个浏览器带着原账号的会话直接登录另一个账号，没有先登出。
  const login = await app.handle(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-forwarded-for': '10.9.0.1',
      },
      body: JSON.stringify({ username: 'stage-run-other', password: 'other-password' }),
    }),
  )
  expect(login.status).toBe(200)
  const state = await stored(run.authorizationId)
  expect(state.status).toBe('ended')
  // 收回的授权不会被当成一批运行回报，也不唤醒。
  expect(state.run).toBeUndefined()
  expect(await wakeRows(run.conversationId)).toHaveLength(0)
})

it('keeps authorizations when the same account logs in again', async () => {
  const run = await proposal(['a'])
  await confirm(run.authorizationId)
  await db
    .update(schema.users)
    .set({ password_hash: await Bun.password.hash('owner-password', { algorithm: 'argon2id' }) })
    .where(eq(schema.users.id, USER_ID))
  const login = await app.handle(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-forwarded-for': '10.9.0.2' },
      body: JSON.stringify({ username: USER_ID, password: 'owner-password' }),
    }),
  )
  expect(login.status).toBe(200)
  expect((await stored(run.authorizationId)).status).toBe('active')
})

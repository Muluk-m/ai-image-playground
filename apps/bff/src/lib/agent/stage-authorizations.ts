import { createHash } from 'node:crypto'
import {
  billedStageQuantity,
  canvasOrigin,
  readCanvasDocument,
  STAGE_RUN_MAX_RETRIES,
  type StageAuthorization,
  type StageAuthorizationCharge,
  type StageAuthorizationPreflight,
  type StageAuthorizationSubmission,
  type StageAuthorizationTurn,
  type StageExecutionBinding,
  type StageExecutionFingerprint,
  type StageStoryboardFinalization,
  stageExecutionBindingMatches,
  stageExecutionSpecsMatch,
  storyboardFingerprint,
  updateCanvasNode,
} from '@image-playground/shared'
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import * as Y from 'yjs'
import { db, schema } from '../../db/client'
import { accessCanvasDocument, CanvasSyncError } from '../canvasSyncStore'
import { isCapabilityEnabled } from '../capabilities'
import { log } from '../logger'
import { type BffTransaction, loadPrivateBffOverlay } from '../private-overlay'

export class StageAuthorizationError extends Error {
  constructor(
    readonly code: string,
    readonly status: 404 | 409 | 422 = 409,
  ) {
    super(code)
  }
}
const table = schema.agent_stage_authorizations
/** 确认后一直没人收尾、也没有在途任务时，过了这段时间就回收。 */
export const STAGE_AUTHORIZATION_ACTIVE_TTL_MS = 30 * 60 * 1000
/** 一轮定期回收最多处理这么多条，剩下的等下一轮。 */
export const STAGE_AUTHORIZATION_EXPIRE_BATCH = 50
const IN_FLIGHT_TASK = new Set(['queued', 'in_progress', 'reconciling'])
const FAILED_TASK = new Set(['failed', 'cancelled'])
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
export interface StageChargeInput {
  readonly nodeId: string
  readonly model: string
  readonly quantity: number
  readonly unitMultiplier: number
}
/** 锁住这个用户的一条授权，并核对会话与项目都还在、仍属于他。 */
export async function lockOwnedStageAuthorization(tx: BffTransaction, userId: string, id: string) {
  return owned(tx, userId, id)
}
/** 执行凭证与授权行上记下的是同一枚。 */
export function stageExecutionTokenMatches(row: typeof table.$inferSelect, token: string) {
  return row.execution_token_hash !== null && row.execution_token_hash === hashToken(token)
}
async function owned(tx: BffTransaction, userId: string, id: string) {
  const [row] = await tx
    .select()
    .from(table)
    .where(and(eq(table.id, id), eq(table.user_id, userId)))
    .for('update')
  if (!row) throw new StageAuthorizationError('stage_authorization_not_found', 404)
  const [project] = await tx
    .select({ id: schema.canvas_projects.id })
    .from(schema.canvas_projects)
    .where(
      and(
        eq(schema.canvas_projects.id, row.project_id),
        eq(schema.canvas_projects.user_id, userId),
        eq(schema.canvas_projects.conversation_id, row.conversation_id),
        isNull(schema.canvas_projects.deleted_at),
      ),
    )
  const [conversation] = await tx
    .select({ id: schema.agent_conversations.id })
    .from(schema.agent_conversations)
    .where(
      and(
        eq(schema.agent_conversations.id, row.conversation_id),
        eq(schema.agent_conversations.user_id, userId),
        isNull(schema.agent_conversations.deleted_at),
      ),
    )
  if (!project || !conversation)
    throw new StageAuthorizationError('stage_authorization_not_found', 404)
  return row
}
async function save(tx: BffTransaction, state: StageAuthorization) {
  await tx.update(table).set({ state, updated_at: Date.now() }).where(eq(table.id, state.id))
  return state
}
function assertExecution(row: typeof table.$inferSelect, token: string) {
  if (row.state.status !== 'active' || row.execution_token_hash !== hashToken(token))
    throw new StageAuthorizationError('stage_authorization_inactive')
}
async function hasInFlight(tx: BffTransaction, state: StageAuthorization): Promise<boolean> {
  const ids = state.attempts.flatMap((attempt) => attempt.taskIds)
  if (!ids.length) return false
  const rows = await tx
    .select({ status: schema.tasks.status })
    .from(schema.tasks)
    .where(inArray(schema.tasks.id, [...ids]))
  return rows.some((row) => IN_FLIGHT_TASK.has(row.status))
}
/** 这些已提交的尝试都以失败或取消收场：节点可以在授权内再试一次。任务行缺了不算。 */
async function startedAttemptsFailed(
  tx: BffTransaction,
  attempts: readonly StageAuthorization['attempts'][number][],
): Promise<boolean> {
  const ids = [...new Set(attempts.flatMap((attempt) => attempt.taskIds))]
  if (!ids.length) return false
  const rows = await tx
    .select({ status: schema.tasks.status })
    .from(schema.tasks)
    .where(inArray(schema.tasks.id, ids))
  return rows.length === ids.length && rows.every((row) => FAILED_TASK.has(row.status))
}
/**
 * 节点的已提交尝试都失败了：按任务实际结算的积分（失败多半已退回）改写这些尝试的占用，退回的部分还给授权。
 * 只有这样，预算正好等于报价的授权才容得下一次自动重试；读不到结算的任务按原占用算，不多放。
 */
async function releaseFailedAttempts(
  tx: BffTransaction,
  state: StageAuthorization,
  nodeId: string,
): Promise<StageAuthorization> {
  const failed = state.attempts.filter(
    (attempt) => attempt.nodeId === nodeId && attempt.taskIds.length > 0,
  )
  if (!failed.length || !(await startedAttemptsFailed(tx, failed))) return state
  const charged: Readonly<Record<string, number>> = isCapabilityEnabled('billing:credits')
    ? await (await loadPrivateBffOverlay()).taskHooks.taskCredits({
        taskIds: failed.flatMap((attempt) => attempt.taskIds),
      })
    : Object.fromEntries(failed.flatMap((attempt) => attempt.taskIds.map((id) => [id, 0])))
  let released = 0
  const attempts = state.attempts.map((attempt) => {
    if (!failed.includes(attempt)) return attempt
    const settled = attempt.taskIds.map((id) => charged[id])
    if (settled.some((credits) => typeof credits !== 'number' || !Number.isFinite(credits)))
      return attempt
    const spent = Math.min(
      attempt.spentCredits,
      settled.reduce<number>((sum, credits) => sum + (credits ?? 0), 0),
    )
    released += attempt.spentCredits - spent
    return {
      ...attempt,
      spentCredits: spent,
      reservedCredits: Math.min(attempt.reservedCredits, spent),
    }
  })
  const spentCredits = state.spentCredits - released
  return {
    ...state,
    attempts,
    spentCredits,
    status:
      state.status === 'exhausted' && spentCredits < state.budgetCap ? 'active' : state.status,
  }
}
async function maybeExpire(tx: BffTransaction, row: typeof table.$inferSelect, now = Date.now()) {
  const state = row.state
  if (state.status !== 'active') return row
  const confirmed = state.audit.find((event) => event.kind === 'confirmed')?.at
  if (
    confirmed === undefined ||
    now - confirmed < STAGE_AUTHORIZATION_ACTIVE_TTL_MS ||
    now - row.updated_at < STAGE_AUTHORIZATION_ACTIVE_TTL_MS
  )
    return row
  if (await hasInFlight(tx, state)) return row
  const expired = await save(tx, {
    ...state,
    status: 'expired',
    audit: [...state.audit, { kind: 'expired', at: now }],
  })
  return { ...row, state: expired }
}
async function pricedCharges(
  tx: BffTransaction,
  userId: string,
  nodes: readonly StageChargeInput[],
): Promise<{ charges: StageAuthorizationCharge[]; total: number }> {
  const billing = isCapabilityEnabled('billing:credits')
  const charges: StageAuthorizationCharge[] = []
  let total = 0
  for (const node of nodes) {
    if (
      billing &&
      (!node.model ||
        !Number.isSafeInteger(node.quantity) ||
        node.quantity < 1 ||
        !Number.isFinite(node.unitMultiplier) ||
        node.unitMultiplier <= 0)
    )
      throw new StageAuthorizationError('stage_authorization_price_unavailable', 422)
    const credits = await quote(tx, userId, {
      model: node.model || 'unpriced',
      quantity: node.quantity > 0 ? node.quantity : 1,
      unitMultiplier: node.unitMultiplier > 0 ? node.unitMultiplier : 1,
    })
    total += credits
    charges.push({ ...node, credits })
  }
  if (!Number.isSafeInteger(total) || total < 0)
    throw new StageAuthorizationError('stage_authorization_price_unavailable', 422)
  return { charges, total }
}
async function quote(
  tx: BffTransaction,
  userId: string,
  input: { model: string; quantity: number; unitMultiplier: number },
) {
  if (!isCapabilityEnabled('billing:credits')) return 0
  const hooks = (await loadPrivateBffOverlay()).taskHooks
  const result = await hooks.quoteTask?.({
    tx,
    userId,
    model: input.model,
    quantity: input.quantity,
    unitMultiplier: input.unitMultiplier,
  })
  if (!result || !Number.isSafeInteger(result.estimatedCredits) || result.estimatedCredits < 0)
    throw new StageAuthorizationError('stage_authorization_price_unavailable', 422)
  return result.estimatedCredits
}
function sameIdSet(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false
  const leftSeen = new Set(left)
  const rightSeen = new Set(right)
  return (
    leftSeen.size === left.length &&
    rightSeen.size === right.length &&
    right.every((id) => leftSeen.has(id))
  )
}
function sameNameList(
  ids: readonly string[],
  names: readonly string[],
  otherIds: readonly string[],
  otherNames: readonly string[],
) {
  if (ids.length !== names.length || otherIds.length !== otherNames.length) return false
  if (!sameIdSet(ids, otherIds)) return false
  const nameOf = new Map(ids.map((id, index) => [id, names[index]]))
  return otherIds.every((id, index) => nameOf.get(id) === otherNames[index])
}
function sameBinding(
  left: StageExecutionBinding | undefined,
  right: StageExecutionBinding,
): boolean {
  if (
    !left ||
    left.kind !== right.kind ||
    left.prompt !== right.prompt ||
    left.inputCount !== right.inputCount
  )
    return false
  const video = left.video
  const given = right.video
  if (!video && !given) return true
  return Boolean(
    video &&
      given &&
      video.durationSeconds === given.durationSeconds &&
      video.resolution === given.resolution &&
      video.aspectRatio === given.aspectRatio,
  )
}
function proposalAgrees(
  row: typeof table.$inferSelect,
  input: {
    userId: string
    projectId: string
    stage: string
    nodeIds: readonly string[]
    nodeNames: readonly string[]
    nodes: readonly StageChargeInput[]
    bindings: readonly StageExecutionBinding[]
    storyboard?: StageStoryboardFinalization
  },
) {
  const state = row.state
  return (
    row.user_id === input.userId &&
    state.storyboard?.storyboardId === input.storyboard?.storyboardId &&
    state.storyboard?.fingerprint === input.storyboard?.fingerprint &&
    row.project_id === input.projectId &&
    state.projectId === input.projectId &&
    state.stage === input.stage &&
    sameNameList(state.nodeIds, state.nodeNames, input.nodeIds, input.nodeNames) &&
    stageExecutionSpecsMatch(input.nodes, state.charges ?? []) &&
    sameIdSet(
      input.bindings.map((binding) => binding.nodeId),
      input.nodeIds,
    ) &&
    input.bindings.every((binding) =>
      sameBinding(
        state.bindings?.find((item) => item.nodeId === binding.nodeId),
        binding,
      ),
    )
  )
}
async function assertStageOwnership(
  tx: BffTransaction,
  userId: string,
  conversationId: string,
  projectId: string,
) {
  const [conversation] = await tx
    .select({
      user_id: schema.agent_conversations.user_id,
      deleted_at: schema.agent_conversations.deleted_at,
    })
    .from(schema.agent_conversations)
    .where(eq(schema.agent_conversations.id, conversationId))
    .for('update')
  const [project] = await tx
    .select({
      user_id: schema.canvas_projects.user_id,
      conversation_id: schema.canvas_projects.conversation_id,
      deleted_at: schema.canvas_projects.deleted_at,
    })
    .from(schema.canvas_projects)
    .where(eq(schema.canvas_projects.id, projectId))
    .for('update')
  if (
    !conversation ||
    conversation.deleted_at ||
    conversation.user_id !== userId ||
    !project ||
    project.deleted_at ||
    project.user_id !== userId ||
    project.conversation_id !== conversationId
  )
    throw new StageAuthorizationError('stage_authorization_scope')
}
export interface StageProposalInput {
  userId: string
  conversationId: string
  projectId: string
  proposalKey: string
  stage: string
  nodeIds: string[]
  nodeNames: string[]
  nodes: readonly StageChargeInput[]
  bindings: readonly StageExecutionBinding[]
  storyboard?: StageStoryboardFinalization
  turn?: StageAuthorizationTurn
}
export async function proposeStageAuthorization(input: StageProposalInput) {
  return db.transaction((tx) => proposeStageAuthorizationInTransaction(tx, input))
}
/** 与画布写入同一事务登记提案：提案失败时本次铺出的节点一起回滚。 */
export async function proposeStageAuthorizationInTransaction(
  tx: BffTransaction,
  input: StageProposalInput,
): Promise<StageAuthorization> {
  const now = Date.now(),
    id = crypto.randomUUID()
  await assertStageOwnership(tx, input.userId, input.conversationId, input.projectId)
  if (
    !sameIdSet(
      input.bindings.map((binding) => binding.nodeId),
      input.nodeIds,
    )
  )
    throw new StageAuthorizationError('stage_authorization_scope')
  const priced = await pricedCharges(tx, input.userId, input.nodes)
  const state: StageAuthorization = {
    id,
    conversationId: input.conversationId,
    projectId: input.projectId,
    stage: input.stage,
    nodeIds: input.nodeIds,
    nodeNames: input.nodeNames,
    estimatedCredits: priced.total,
    budgetCap: priced.total,
    charges: priced.charges,
    bindings: input.bindings,
    ...(input.storyboard
      ? {
          storyboard: {
            storyboardId: input.storyboard.storyboardId,
            fingerprint: input.storyboard.fingerprint,
          },
        }
      : {}),
    ...(input.turn ? { turn: input.turn } : {}),
    spentCredits: 0,
    status: 'pending',
    attempts: [],
    audit: [{ kind: 'proposed', at: now }],
  }
  const inserted = await tx
    .insert(table)
    .values({
      id,
      user_id: input.userId,
      conversation_id: input.conversationId,
      project_id: input.projectId,
      proposal_key: input.proposalKey,
      state,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing()
    .returning({ id: table.id })
  if (inserted.length > 0) return state
  const [row] = await tx
    .select()
    .from(table)
    .where(
      and(
        eq(table.conversation_id, input.conversationId),
        eq(table.proposal_key, input.proposalKey),
      ),
    )
    .for('update')
  if (!row) throw new StageAuthorizationError('stage_authorization_conflict')
  if (!proposalAgrees(row, input)) throw new StageAuthorizationError('stage_authorization_conflict')
  return row.state
}
/**
 * 同一次工具调用（proposalKey）已经登记过的提案。幂等重放时直接返回它，
 * 不再按当前画布重新提案：画布在首次登记后可能已被改过。
 */
export async function readStageProposal(
  userId: string,
  conversationId: string,
  proposalKey: string,
  tx?: BffTransaction,
): Promise<StageAuthorization | undefined> {
  if (!tx)
    return db.transaction((inner) => readStageProposal(userId, conversationId, proposalKey, inner))
  const [row] = await tx
    .select()
    .from(table)
    .where(
      and(
        eq(table.user_id, userId),
        eq(table.conversation_id, conversationId),
        eq(table.proposal_key, proposalKey),
      ),
    )
    .for('update')
  // 与 readStageAuthorization 一样先按 TTL 收回，重放不能把已过期的授权说成仍可运行。
  return row ? (await maybeExpire(tx, row)).state : undefined
}
export async function readStageAuthorization(userId: string, id: string) {
  return db.transaction(async (tx) => (await maybeExpire(tx, await owned(tx, userId, id))).state)
}
async function confirmInTransaction(
  tx: BffTransaction,
  userId: string,
  id: string,
  charges?: readonly StageChargeInput[],
) {
  const row = await maybeExpire(tx, await owned(tx, userId, id))
  if (row.state.status !== 'pending')
    throw new StageAuthorizationError('stage_authorization_already_confirmed')
  let state = row.state
  if (charges?.length) {
    const normalized = charges.map((charge) => ({
      ...charge,
      quantity: billedStageQuantity(charge.quantity),
    }))
    const wanted = new Set(state.nodeIds)
    const given = new Set(normalized.map((charge) => charge.nodeId))
    // 重复的 nodeId 用 Set 会看起来刚好覆盖范围，但报价会被加两次。
    if (
      normalized.length !== wanted.size ||
      given.size !== wanted.size ||
      [...wanted].some((nodeId) => !given.has(nodeId))
    )
      throw new StageAuthorizationError('stage_authorization_scope')
    const stored = state.charges ?? []
    // 提案快照是唯一可执行规格。现场模型或数量变了就拒绝，不能在确认时改价。
    if (!stageExecutionSpecsMatch(normalized, stored))
      throw new StageAuthorizationError('stage_authorization_stale')
    const billing = isCapabilityEnabled('billing:credits')
    state = {
      ...state,
      charges: stored.map((charge) => {
        const givenCharge = normalized.find((item) => item.nodeId === charge.nodeId)
        if (!charge.model && !billing && givenCharge?.model)
          return { ...charge, model: givenCharge.model }
        return charge
      }),
    }
  }
  const executionToken = crypto.randomUUID()
  await tx
    .update(table)
    .set({ execution_token_hash: hashToken(executionToken) })
    .where(eq(table.id, id))
  const authorization = await save(tx, {
    ...state,
    status: 'active',
    audit: [...state.audit, { kind: 'confirmed', at: Date.now() }],
  })
  return { authorization, executionToken }
}
const finalizeOrigin = canvasOrigin('system', 'stage-authorization')
/**
 * 首帧阶段「确认即定稿」：在授权确认的同一事务里把分镜表写成定稿。
 * 镜头表在提案之后改过就拒绝，授权保持待确认，需要重新提案。已经是同一份定稿时不写。
 */
function finalizeStoryboard(
  doc: Y.Doc,
  storyboard: StageStoryboardFinalization,
  authorization: StageAuthorization,
): Uint8Array | undefined {
  const board = readCanvasDocument(doc).nodes.find((node) => node.id === storyboard.storyboardId)
  if (
    board?.type !== 'storyboard' ||
    storyboardFingerprint(board.data.shots) !== storyboard.fingerprint
  )
    throw new StageAuthorizationError('stage_authorization_stale')
  if (board.data.confirmed?.fingerprint === storyboard.fingerprint) return undefined
  const draft = new Y.Doc({ gc: false })
  try {
    Y.applyUpdate(draft, Y.encodeStateAsUpdate(doc))
    const vector = Y.encodeStateVector(draft)
    updateCanvasNode(
      draft,
      board.id,
      {
        data: {
          ...board.data,
          confirmed: {
            fingerprint: storyboard.fingerprint,
            model: authorization.charges?.find((charge) => charge.model)?.model ?? '',
            quantity: board.data.shots.length,
            credits: authorization.budgetCap,
          },
        },
      },
      finalizeOrigin,
    )
    return Y.encodeStateAsUpdate(draft, vector)
  } finally {
    draft.destroy()
  }
}
export async function confirmStageAuthorization(
  userId: string,
  id: string,
  charges?: readonly StageChargeInput[],
): Promise<{ authorization: StageAuthorization; executionToken: string }> {
  const [peek] = await db
    .select({ projectId: table.project_id, state: table.state })
    .from(table)
    .where(and(eq(table.id, id), eq(table.user_id, userId)))
  const storyboard = peek?.state.storyboard
  if (!peek || !storyboard)
    return db.transaction((tx) => confirmInTransaction(tx, userId, id, charges))
  // 画布文档与授权在同一事务里提交：定稿失败时授权不生效，授权失败时也不留定稿。
  let confirmed: { authorization: StageAuthorization; executionToken: string } | undefined
  try {
    await accessCanvasDocument(userId, peek.projectId, async (doc, tx) => {
      confirmed = await confirmInTransaction(tx, userId, id, charges)
      return finalizeStoryboard(doc, storyboard, confirmed.authorization)
    })
  } catch (error) {
    if (error instanceof CanvasSyncError)
      throw new StageAuthorizationError(
        error.status === 400 ? 'stage_authorization_stale' : 'stage_authorization_not_found',
        error.status === 400 ? 409 : 404,
      )
    throw error
  }
  if (!confirmed) throw new StageAuthorizationError('stage_authorization_not_found', 404)
  return confirmed
}
/**
 * 登出时在一个事务里收回这个用户还开着的阶段授权。
 * 已结束或已过期的行保持原样。锁住待处理行，避免逐条事务把登出拖住，也不把并发里已经结束的行算成失败。
 */
export async function endStageAuthorizationsForUser(userId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(table)
      .where(
        and(eq(table.user_id, userId), sql`${table.state}->>'status' in ('pending', 'active')`),
      )
      .for('update')
    const now = Date.now()
    let ended = 0
    for (const row of rows) {
      const current = await maybeExpire(tx, row, now)
      if (current.state.status !== 'pending' && current.state.status !== 'active') continue
      await save(tx, {
        ...current.state,
        status: 'ended',
        audit: [...current.state.audit, { kind: 'ended', at: now }],
      })
      ended += 1
    }
    return ended
  })
}
export async function endStageAuthorization(userId: string, id: string) {
  return db.transaction(async (tx) => {
    const row = await maybeExpire(tx, await owned(tx, userId, id))
    if (row.state.status === 'ended' || row.state.status === 'expired') return row.state
    return save(tx, {
      ...row.state,
      status: 'ended',
      audit: [...row.state.audit, { kind: 'ended', at: Date.now() }],
    })
  })
}
/**
 * 一条授权里仍在排队、执行或对账的任务。
 * jsonb_array_elements_text 必须写成列别名 task_value(task_id)，再比 task_value.task_id。
 * 只写 `as task_id` 时那是表别名，`tasks.id = task_id` 会拿整行来比。
 * 过期扫描的 NOT EXISTS 与测试都调用这一段，不能各写一份。
 */
export function stageAuthorizationInFlightTaskIds() {
  return sql`
    select task_value.task_id as task_id
    from jsonb_array_elements(coalesce(${table.state}->'attempts', '[]'::jsonb)) as attempt
    cross join lateral jsonb_array_elements_text(
      case
        when jsonb_typeof(attempt->'taskIds') = 'array' then attempt->'taskIds'
        else '[]'::jsonb
      end
    ) as task_value(task_id)
    inner join ${schema.tasks} on ${schema.tasks.id} = task_value.task_id
    where ${schema.tasks.status} in ('queued', 'in_progress', 'reconciling')
  `
}
/** 查询时就排除在途任务，避免最老的一批全是在途、后面的空闲授权永远轮不到。 */
function withoutInFlightTasks() {
  return sql`not exists (${stageAuthorizationInFlightTaskIds()})`
}
export async function expireStaleStageAuthorizations(now = Date.now()): Promise<number> {
  const cutoff = now - STAGE_AUTHORIZATION_ACTIVE_TTL_MS
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(
      and(
        sql`${table.state}->>'status' = 'active'`,
        lt(table.updated_at, cutoff),
        withoutInFlightTasks(),
      ),
    )
    .orderBy(asc(table.updated_at), asc(table.id))
    .limit(STAGE_AUTHORIZATION_EXPIRE_BATCH)
  let expired = 0
  for (const candidate of rows) {
    const did = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(table).where(eq(table.id, candidate.id)).for('update')
      if (!locked) return false
      const next = await maybeExpire(tx, locked, now)
      return next.state.status === 'expired'
    })
    if (did) expired += 1
  }
  return expired
}
export async function preflightStageAuthorization(
  userId: string,
  id: string,
  input: StageAuthorizationPreflight,
) {
  return db.transaction(async (tx) => {
    let row = await maybeExpire(tx, await owned(tx, userId, id))
    // 额度用尽后只有授权内的自动重试还能再要：失败任务退回的额度先还给授权，仍然不够就说成超预算，
    // 浏览器据此停下，请智能体重新申请授权。
    if (row.state.status === 'exhausted' && stageExecutionTokenMatches(row, input.executionToken)) {
      const released = await releaseFailedAttempts(tx, row.state, input.nodeId)
      if (released.status === 'exhausted')
        throw new StageAuthorizationError('stage_authorization_budget')
      row = { ...row, state: released }
    }
    assertExecution(row, input.executionToken)
    let state = row.state
    if (!state.nodeIds.includes(input.nodeId))
      throw new StageAuthorizationError('stage_authorization_scope')
    const quantity = billedStageQuantity(input.quantity)
    // 确认后的报价是唯一可执行规格。换模型、数量或倍率必须重新提案。
    let charge = state.charges?.find((item) => item.nodeId === input.nodeId)
    // 不计费且提案时没有可用模型，占位模型是空字符串。预检带来的是原标签页实际要跑的模型，写回去再锁住。
    if (
      charge &&
      !charge.model &&
      !isCapabilityEnabled('billing:credits') &&
      input.model &&
      charge.quantity === quantity &&
      charge.unitMultiplier === input.unitMultiplier
    ) {
      const charges = (state.charges ?? []).map((item) =>
        item.nodeId === input.nodeId ? { ...item, model: input.model } : item,
      )
      state = { ...state, charges }
      charge = charges.find((item) => item.nodeId === input.nodeId)
    }
    if (
      !charge ||
      charge.model !== input.model ||
      charge.quantity !== quantity ||
      charge.unitMultiplier !== input.unitMultiplier
    )
      throw new StageAuthorizationError('stage_authorization_scope')
    const previous = state.attempts.find((attempt) => attempt.id === input.attemptId)
    if (previous) {
      if (
        previous.nodeId !== input.nodeId ||
        previous.model !== input.model ||
        previous.quantity !== quantity ||
        previous.unitMultiplier !== input.unitMultiplier
      )
        throw new StageAuthorizationError('stage_authorization_attempt_conflict')
      return state
    }
    // A submitted node stays taken unless every submitted attempt failed: then it may be retried
    // STAGE_RUN_MAX_RETRIES times. The failed attempts keep counting what they were actually charged.
    // An attempt that never created a task can be replaced, so cancel or a lost submit does not
    // block this authorization or a later one.
    const started = state.attempts.filter(
      (attempt) => attempt.nodeId === input.nodeId && attempt.taskIds.length > 0,
    )
    const retry = started.length > 0
    if (retry) {
      if (started.length > STAGE_RUN_MAX_RETRIES)
        throw new StageAuthorizationError('stage_authorization_retry_limit')
      if (!(await startedAttemptsFailed(tx, started)))
        throw new StageAuthorizationError('stage_authorization_node_already_started')
      state = await releaseFailedAttempts(tx, state, input.nodeId)
    }
    const openAttempts = state.attempts.filter(
      (attempt) => attempt.nodeId !== input.nodeId || attempt.taskIds.length > 0,
    )
    const credits = await quote(tx, userId, { ...input, quantity })
    const committed = openAttempts.reduce((sum, attempt) => sum + attempt.reservedCredits, 0)
    if (committed + credits > state.budgetCap)
      throw new StageAuthorizationError('stage_authorization_budget')
    return save(tx, {
      ...state,
      attempts: [
        ...openAttempts,
        {
          id: input.attemptId,
          nodeId: input.nodeId,
          model: input.model,
          quantity,
          unitMultiplier: input.unitMultiplier,
          reservedCredits: credits,
          spentCredits: 0,
          submittedQuantity: 0,
          taskIds: [],
        },
      ],
      audit: [
        ...state.audit,
        { kind: retry ? 'retry' : 'preflight', at: Date.now(), nodeId: input.nodeId, credits },
      ],
    })
  })
}
/** Called inside the queue task transaction: a failed gate rolls back task and billing together. */
export async function consumeStageAuthorization(
  tx: BffTransaction,
  userId: string | null,
  ref: StageAuthorizationSubmission,
  taskId: string,
  usage: { model: string; quantity: number; unitMultiplier: number },
  credits: number,
  execution: StageExecutionFingerprint,
) {
  if (!userId) throw new StageAuthorizationError('stage_authorization_inactive')
  const quantity = billedStageQuantity(usage.quantity)
  if (
    !Number.isFinite(credits) ||
    credits < 0 ||
    !Number.isFinite(usage.quantity) ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    !Number.isFinite(usage.unitMultiplier) ||
    usage.unitMultiplier <= 0
  )
    throw new StageAuthorizationError('stage_authorization_attempt_conflict')
  const row = await maybeExpire(tx, await owned(tx, userId, ref.authorizationId))
  assertExecution(row, ref.executionToken)
  const state = row.state,
    attempt = state.attempts.find((item) => item.id === ref.attemptId)
  if (!state.nodeIds.includes(ref.nodeId) || !attempt || attempt.nodeId !== ref.nodeId)
    throw new StageAuthorizationError('stage_authorization_scope')
  if (attempt.taskIds.includes(taskId)) return
  if (
    attempt.model !== usage.model ||
    attempt.unitMultiplier !== usage.unitMultiplier ||
    attempt.submittedQuantity + quantity > attempt.quantity
  )
    throw new StageAuthorizationError('stage_authorization_attempt_conflict')
  const binding = state.bindings?.find((item) => item.nodeId === ref.nodeId)
  if (!binding || !stageExecutionBindingMatches(binding, execution))
    throw new StageAuthorizationError('stage_authorization_scope')
  if (
    attempt.spentCredits + credits > attempt.reservedCredits ||
    state.spentCredits + credits > state.budgetCap
  )
    throw new StageAuthorizationError('stage_authorization_budget')
  const spentCredits = state.spentCredits + credits
  const exhausted = state.budgetCap > 0 && spentCredits >= state.budgetCap
  await save(tx, {
    ...state,
    spentCredits,
    status: exhausted ? 'exhausted' : 'active',
    attempts: state.attempts.map((item) =>
      item.id !== attempt.id
        ? item
        : {
            ...attempt,
            submittedQuantity: attempt.submittedQuantity + quantity,
            spentCredits: attempt.spentCredits + credits,
            taskIds: [...attempt.taskIds, taskId],
          },
    ),
    audit: [
      ...state.audit,
      { kind: 'submitted', at: Date.now(), nodeId: ref.nodeId, taskId, credits },
      ...(exhausted ? [{ kind: 'exhausted' as const, at: Date.now() }] : []),
    ],
  })
  log.info(
    {
      event: 'agent.stage.submitted',
      authorizationId: state.id,
      nodeId: ref.nodeId,
      taskId,
      credits,
      spentCredits,
    },
    'Authorized canvas task submitted',
  )
}

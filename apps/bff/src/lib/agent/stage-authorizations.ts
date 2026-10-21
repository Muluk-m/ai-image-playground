import { createHash } from 'node:crypto'
import type {
  StageAuthorization,
  StageAuthorizationCharge,
  StageAuthorizationPreflight,
  StageAuthorizationSubmission,
} from '@image-playground/shared'
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
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
const IN_FLIGHT_TASK = new Set(['queued', 'in_progress', 'reconciling'])
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
export interface StageChargeInput {
  readonly nodeId: string
  readonly model: string
  readonly quantity: number
  readonly unitMultiplier: number
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
export async function proposeStageAuthorization(input: {
  userId: string
  conversationId: string
  projectId: string
  proposalKey: string
  stage: string
  nodeIds: string[]
  nodeNames: string[]
  nodes: readonly StageChargeInput[]
}) {
  const now = Date.now(),
    id = crypto.randomUUID()
  return db.transaction(async (tx) => {
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
      spentCredits: 0,
      status: 'pending',
      attempts: [],
      audit: [{ kind: 'proposed', at: now }],
    }
    await tx
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
    const [row] = await tx
      .select()
      .from(table)
      .where(
        and(
          eq(table.conversation_id, input.conversationId),
          eq(table.proposal_key, input.proposalKey),
          eq(table.user_id, input.userId),
        ),
      )
    return row!.state
  })
}
export async function readStageAuthorization(userId: string, id: string) {
  return db.transaction(async (tx) => (await maybeExpire(tx, await owned(tx, userId, id))).state)
}
export async function confirmStageAuthorization(
  userId: string,
  id: string,
  charges?: readonly StageChargeInput[],
) {
  return db.transaction(async (tx) => {
    const row = await maybeExpire(tx, await owned(tx, userId, id))
    if (row.state.status !== 'pending')
      throw new StageAuthorizationError('stage_authorization_already_confirmed')
    let state = row.state
    if (charges?.length) {
      const wanted = new Set(state.nodeIds)
      const given = new Set(charges.map((charge) => charge.nodeId))
      if (wanted.size !== given.size || [...wanted].some((nodeId) => !given.has(nodeId)))
        throw new StageAuthorizationError('stage_authorization_scope')
      const priced = await pricedCharges(tx, userId, charges)
      state = {
        ...state,
        estimatedCredits: priced.total,
        budgetCap: priced.total,
        charges: priced.charges,
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
export async function expireStaleStageAuthorizations(now = Date.now()): Promise<number> {
  const cutoff = now - STAGE_AUTHORIZATION_ACTIVE_TTL_MS
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(and(sql`${table.state}->>'status' = 'active'`, lt(table.updated_at, cutoff)))
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
    const row = await maybeExpire(tx, await owned(tx, userId, id))
    assertExecution(row, input.executionToken)
    const state = row.state
    if (!state.nodeIds.includes(input.nodeId))
      throw new StageAuthorizationError('stage_authorization_scope')
    const previous = state.attempts.find((attempt) => attempt.id === input.attemptId)
    if (previous) {
      if (
        previous.nodeId !== input.nodeId ||
        previous.model !== input.model ||
        previous.quantity !== input.quantity ||
        previous.unitMultiplier !== input.unitMultiplier
      )
        throw new StageAuthorizationError('stage_authorization_attempt_conflict')
      return state
    }
    // A submitted node stays taken. An attempt that never created a task can be replaced,
    // so cancel or a lost submit does not block this authorization or a later one.
    if (
      state.attempts.some(
        (attempt) => attempt.nodeId === input.nodeId && attempt.taskIds.length > 0,
      )
    )
      throw new StageAuthorizationError('stage_authorization_node_already_started')
    const openAttempts = state.attempts.filter((attempt) => attempt.nodeId !== input.nodeId)
    const credits = await quote(tx, userId, input)
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
          quantity: input.quantity,
          unitMultiplier: input.unitMultiplier,
          reservedCredits: credits,
          spentCredits: 0,
          submittedQuantity: 0,
          taskIds: [],
        },
      ],
      audit: [...state.audit, { kind: 'preflight', at: Date.now(), nodeId: input.nodeId, credits }],
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
) {
  if (!userId) throw new StageAuthorizationError('stage_authorization_inactive')
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
    attempt.submittedQuantity + usage.quantity > attempt.quantity
  )
    throw new StageAuthorizationError('stage_authorization_attempt_conflict')
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
            submittedQuantity: attempt.submittedQuantity + usage.quantity,
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

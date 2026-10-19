import { createHash } from 'node:crypto'
import type {
  StageAuthorization,
  StageAuthorizationPreflight,
  StageAuthorizationSubmission,
} from '@image-playground/shared'
import { and, eq, isNull } from 'drizzle-orm'
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
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
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
  estimatedCredits: number
}) {
  const now = Date.now(),
    id = crypto.randomUUID()
  const state: StageAuthorization = {
    id,
    conversationId: input.conversationId,
    projectId: input.projectId,
    stage: input.stage,
    nodeIds: input.nodeIds,
    nodeNames: input.nodeNames,
    estimatedCredits: input.estimatedCredits,
    budgetCap: input.estimatedCredits,
    spentCredits: 0,
    status: 'pending',
    attempts: [],
    audit: [{ kind: 'proposed', at: now }],
  }
  return db.transaction(async (tx) => {
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
  return db.transaction(async (tx) => (await owned(tx, userId, id)).state)
}
export async function confirmStageAuthorization(userId: string, id: string) {
  return db.transaction(async (tx) => {
    const row = await owned(tx, userId, id)
    if (row.state.status !== 'pending')
      throw new StageAuthorizationError('stage_authorization_already_confirmed')
    const executionToken = crypto.randomUUID()
    await tx
      .update(table)
      .set({ execution_token_hash: hashToken(executionToken) })
      .where(eq(table.id, id))
    const authorization = await save(tx, {
      ...row.state,
      status: 'active',
      audit: [...row.state.audit, { kind: 'confirmed', at: Date.now() }],
    })
    return { authorization, executionToken }
  })
}
export async function endStageAuthorization(userId: string, id: string) {
  return db.transaction(async (tx) => {
    const row = await owned(tx, userId, id)
    if (row.state.status === 'ended') return row.state
    return save(tx, {
      ...row.state,
      status: 'ended',
      audit: [...row.state.audit, { kind: 'ended', at: Date.now() }],
    })
  })
}
export async function preflightStageAuthorization(
  userId: string,
  id: string,
  input: StageAuthorizationPreflight,
) {
  return db.transaction(async (tx) => {
    const row = await owned(tx, userId, id)
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
    // Another tab or repeated event cannot start the same authorized node a second time.
    if (state.attempts.some((attempt) => attempt.nodeId === input.nodeId))
      throw new StageAuthorizationError('stage_authorization_node_already_started')
    const credits = await quote(tx, userId, input)
    const committed = state.attempts.reduce((sum, attempt) => sum + attempt.reservedCredits, 0)
    if (committed + credits > state.budgetCap)
      throw new StageAuthorizationError('stage_authorization_budget')
    return save(tx, {
      ...state,
      attempts: [
        ...state.attempts,
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
  const row = await owned(tx, userId, ref.authorizationId)
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

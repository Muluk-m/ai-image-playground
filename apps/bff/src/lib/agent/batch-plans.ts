import { createHash } from 'node:crypto'
import type {
  AgentBatchEstimates,
  AgentBatchItem,
  AgentBatchPage,
  AgentBatchPriceSnapshot,
  AgentBatchUpdate,
  AgentBatchView,
  AgentMediaReference,
} from '@image-playground/shared'
import { and, asc, eq, gt, inArray, isNull, lte } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { isCapabilityEnabled } from '../capabilities'
import { type BffTransaction, loadPrivateBffOverlay } from '../private-overlay'
import { lockConversation } from './confirmations'
import { AgentToolError } from './tools/errors'
import { resolveAgentModel } from './tools/queueTask'
import type { AgentToolAudience, AgentToolContext } from './tools/types'

export function batchPlansAvailable(audience?: AgentToolAudience): boolean {
  return (
    Boolean(audience?.userId) &&
    isCapabilityEnabled('agent:chat') &&
    isCapabilityEnabled('agent:attachments') &&
    isCapabilityEnabled('agent:batch-plans')
  )
}

interface PlanInput {
  readonly title: string
  readonly rule: string
  readonly items: readonly {
    readonly key: string
    readonly imageIds: readonly string[]
    readonly prompt: string
    readonly dependencies: readonly string[]
  }[]
}

function invalid(message: string): never {
  throw new AgentToolError('invalid_params', message)
}

const emptyEstimate = {
  status: 'available' as const,
  estimatedCredits: 0,
  estimatedChargeCredits: 0,
  snapshots: [],
}

export async function createAgentBatchPlan(
  context: AgentToolContext,
  toolCallId: string,
  input: PlanInput,
): Promise<string> {
  if (!batchPlansAvailable(context) || !context.userId) invalid('请登录后使用批次计划。')
  const userId = context.userId
  const target = resolveAgentModel('image', context.params?.model)
  if (!target) throw new AgentToolError('model_unavailable', '暂时没有可用的生图模型')
  const keys = new Set<string>()
  const { autoSubmit: _autoSubmit, ...params } = context.params ?? {}
  const items: AgentBatchItem[] = input.items.map((item, ordinal) => {
    if (!item.key.trim() || keys.has(item.key) || !item.prompt.trim())
      invalid('处理项编号不能重复，提示词不能为空。')
    if (item.dependencies.some((key) => !keys.has(key))) invalid('依赖必须指向前面的处理项。')
    keys.add(item.key)
    const inputs = item.imageIds.map((imageId): AgentMediaReference => {
      const identified = context.images.identify(imageId)
      const reference = context.images.references.find((one) => one.imageId === identified)
      if (!reference || !('mediaId' in reference))
        invalid(`图片 ${imageId} 没有可持久保存的完整输入，请重新附上原图。`)
      return { ...reference, imageId: identified }
    })
    return {
      key: item.key,
      ordinal,
      kind: 'generation',
      inputs,
      prompt: item.prompt,
      params: { ...params, ...target },
      dependencies: item.dependencies,
    }
  })
  const now = Date.now()
  return db.transaction(async (tx) => {
    await lockConversation(tx, context.conversationId, userId)
    const [conversation] = await tx
      .select({ id: schema.agent_conversations.id })
      .from(schema.agent_conversations)
      .where(
        and(
          eq(schema.agent_conversations.id, context.conversationId),
          eq(schema.agent_conversations.user_id, userId),
          isNull(schema.agent_conversations.deleted_at),
        ),
      )
    if (!conversation) invalid('会话已不可用。')
    const [existing] = await tx
      .select({ id: schema.agent_batches.id })
      .from(schema.agent_batches)
      .where(
        and(
          eq(schema.agent_batches.conversation_id, context.conversationId),
          eq(schema.agent_batches.origin_turn_id, context.turnId),
          eq(schema.agent_batches.tool_call_id, toolCallId),
        ),
      )
    if (existing) return existing.id
    const mediaIds = [...new Set(items.flatMap((item) => item.inputs.map((one) => one.mediaId)))]
    const ready = await tx
      .select({ id: schema.media_objects.id })
      .from(schema.media_objects)
      .where(
        and(
          eq(schema.media_objects.user_id, userId),
          eq(schema.media_objects.status, 'ready'),
          inArray(schema.media_objects.id, mediaIds),
        ),
      )
    if (ready.length !== mediaIds.length) invalid('批次所需的图片已不可用，请检查完整范围。')
    const [project] = await tx
      .select({ id: schema.canvas_projects.id, revision: schema.canvas_projects.revision })
      .from(schema.canvas_projects)
      .where(
        and(
          eq(schema.canvas_projects.conversation_id, context.conversationId),
          eq(schema.canvas_projects.user_id, userId),
          isNull(schema.canvas_projects.deleted_at),
        ),
      )
      .limit(1)
    const id = crypto.randomUUID()
    const estimate = await quoteBatchPlan(tx, userId, items)
    const digest = createHash('sha256')
      .update(JSON.stringify({ title: input.title, rule: input.rule, items, estimate }))
      .digest('hex')
    await tx.insert(schema.agent_batches).values({
      id,
      user_id: userId,
      conversation_id: context.conversationId,
      origin_turn_id: context.turnId,
      tool_call_id: toolCallId,
      experience: context.experience ?? 'chat',
      project_id: project?.id ?? null,
      project_revision: project?.revision ?? null,
      created_at: now,
      updated_at: now,
    })
    await tx.insert(schema.agent_batch_plans).values({
      batch_id: id,
      version: 1,
      title: input.title,
      rule: input.rule,
      digest,
      item_count: items.length,
      estimate_snapshot: estimate,
      created_at: now,
    })
    await tx
      .insert(schema.agent_batch_items)
      .values(items.map((item) => ({ batch_id: id, version: 1, ...item })))
    await tx.insert(schema.media_references).values(
      mediaIds.map((mediaId) => ({
        user_id: userId,
        media_id: mediaId,
        owner_kind: 'batch' as const,
        owner_id: id,
        created_at: now,
      })),
    )
    return id
  })
}

export class BatchPlanError extends Error {
  constructor(
    readonly code:
      | 'batch_execution_unavailable'
      | 'batch_size_exceeded'
      | 'batch_price_changed'
      | 'batch_submission_refused'
      | 'batch_insufficient_credits'
      | 'batch_version_conflict'
      | 'invalid_batch_plan'
      | 'invalid_batch_cursor'
      | 'batch_not_found',
    readonly status: 400 | 404 | 409 | 422,
  ) {
    super(code)
  }
}

export async function readAgentBatchPlan(
  userId: string,
  id: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<AgentBatchPage | null> {
  let version: number | undefined
  let after = -1
  if (options.cursor) {
    try {
      const value: unknown = JSON.parse(Buffer.from(options.cursor, 'base64url').toString())
      if (
        !Array.isArray(value) ||
        value.length !== 3 ||
        value[0] !== id ||
        !Number.isSafeInteger(value[1]) ||
        value[1] < 1 ||
        !Number.isSafeInteger(value[2]) ||
        value[2] < 0
      )
        throw new Error('cursor')
      version = value[1]
      after = value[2]
    } catch {
      throw new BatchPlanError('invalid_batch_cursor', 400)
    }
  }
  const limit = options.limit ?? 100
  const [row] = await db
    .select()
    .from(schema.agent_batches)
    .innerJoin(
      schema.agent_batch_plans,
      and(
        eq(schema.agent_batches.id, schema.agent_batch_plans.batch_id),
        version === undefined
          ? eq(schema.agent_batches.current_version, schema.agent_batch_plans.version)
          : eq(schema.agent_batch_plans.version, version),
      ),
    )
    .innerJoin(
      schema.agent_conversations,
      eq(schema.agent_batches.conversation_id, schema.agent_conversations.id),
    )
    .where(
      and(
        eq(schema.agent_batches.id, id),
        eq(schema.agent_batches.user_id, userId),
        isNull(schema.agent_conversations.deleted_at),
      ),
    )
    .limit(1)
  if (!row) return null
  const { agent_batches: batch, agent_batch_plans: plan } = row
  const items = await db
    .select()
    .from(schema.agent_batch_items)
    .where(
      and(
        eq(schema.agent_batch_items.batch_id, id),
        eq(schema.agent_batch_items.version, plan.version),
        gt(schema.agent_batch_items.ordinal, after),
      ),
    )
    .orderBy(asc(schema.agent_batch_items.ordinal))
    .limit(limit + 1)
  const attempts = await db
    .select({
      itemKey: schema.agent_batch_attempts.item_key,
      attempt: schema.agent_batch_attempts.attempt,
      taskId: schema.agent_batch_attempts.task_id,
      status: schema.tasks.status,
    })
    .from(schema.agent_batch_attempts)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.agent_batch_attempts.task_id))
    .where(
      and(
        eq(schema.agent_batch_attempts.batch_id, id),
        lte(schema.agent_batch_attempts.version, plan.version),
      ),
    )
  const terminal = attempts.filter((one) =>
    ['completed', 'failed', 'cancelled'].includes(one.status),
  )
  const credits = terminal.length
    ? await (await loadPrivateBffOverlay()).taskHooks.taskCredits({
        taskIds: terminal.map((one) => one.taskId),
      })
    : {}
  const execution = new Map(
    attempts.map((one) => [
      one.itemKey,
      {
        taskId: one.taskId,
        status: one.status,
        attempt: one.attempt,
        actualCredits: terminal.includes(one) ? (credits[one.taskId] ?? null) : null,
      },
    ]),
  )
  const complete = batch.confirmed_version === plan.version && terminal.length === plan.item_count
  return {
    batch: {
      id: batch.id,
      conversationId: batch.conversation_id,
      originTurnId: batch.origin_turn_id,
      experience: batch.experience,
      projectId: batch.project_id,
      targetSnapshot: { projectId: batch.project_id, projectRevision: batch.project_revision },
      version: plan.version,
      digest: plan.digest,
      title: plan.title,
      rule: plan.rule,
      itemCount: plan.item_count,
      status: complete ? 'closed' : batch.status,
      executionEnabled:
        batchPlansAvailable({ userId }) && isCapabilityEnabled('agent:batch-execution'),
      pauseReason: batch.pause_reason,
      confirmationRequired: batch.confirmed_version !== batch.current_version,
      submittedCount: attempts.length,
      actualCredits: Object.values(credits).reduce((sum, value) => sum + value, 0),
      estimate: plan.estimate_snapshot,
      createdAt: batch.created_at,
    } satisfies AgentBatchView,
    items: items.slice(0, limit).map(({ batch_id: _batch, version: _version, ...item }) => ({
      ...item,
      ...(execution.has(item.key) ? { execution: execution.get(item.key)! } : {}),
    })),
    nextCursor:
      items.length > limit
        ? Buffer.from(JSON.stringify([id, plan.version, items[limit - 1]!.ordinal])).toString(
            'base64url',
          )
        : null,
  }
}

export async function updateAgentBatchPlan(
  userId: string,
  id: string,
  input: AgentBatchUpdate,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [origin] = await tx
      .select({ conversationId: schema.agent_batches.conversation_id })
      .from(schema.agent_batches)
      .where(and(eq(schema.agent_batches.id, id), eq(schema.agent_batches.user_id, userId)))
    if (!origin?.conversationId) throw new BatchPlanError('batch_not_found', 404)
    // lockConversation acquires media owner, then conversation; the batch row is always last.
    await lockConversation(tx, origin.conversationId, userId)
    const [batch] = await tx
      .select()
      .from(schema.agent_batches)
      .where(and(eq(schema.agent_batches.id, id), eq(schema.agent_batches.user_id, userId)))
      .for('update')
    if (!batch || batch.conversation_id !== origin.conversationId)
      throw new BatchPlanError('batch_not_found', 404)
    const [conversation] = await tx
      .select({ id: schema.agent_conversations.id })
      .from(schema.agent_conversations)
      .where(
        and(
          eq(schema.agent_conversations.id, batch.conversation_id),
          isNull(schema.agent_conversations.deleted_at),
        ),
      )
    if (!conversation) throw new BatchPlanError('batch_not_found', 404)
    if (batch.status !== 'draft' || batch.current_version !== input.expectedVersion)
      throw new BatchPlanError('batch_version_conflict', 409)
    if (!input.title.trim() || !input.rule.trim())
      throw new BatchPlanError('invalid_batch_plan', 422)
    const messages = await tx
      .select({ content: schema.agent_messages.content })
      .from(schema.agent_messages)
      .where(
        and(
          eq(schema.agent_messages.conversation_id, batch.conversation_id),
          eq(schema.agent_messages.role, 'user'),
          isNull(schema.agent_messages.deleted_at),
        ),
      )
    const references = messages
      .flatMap((message) =>
        message.content.flatMap((block) => (block.type === 'text' ? (block.references ?? []) : [])),
      )
      .filter((reference): reference is AgentMediaReference => 'mediaId' in reference)
    const keys = new Set<string>()
    const items: AgentBatchItem[] = input.items.map((item, ordinal) => {
      if (
        !item.key.trim() ||
        keys.has(item.key) ||
        !item.prompt.trim() ||
        item.dependencies.some((key) => !keys.has(key))
      )
        throw new BatchPlanError('invalid_batch_plan', 422)
      keys.add(item.key)
      const target = resolveAgentModel('image', item.params.model)
      if (!target || target.model !== item.params.model || target.provider !== item.params.provider)
        throw new BatchPlanError('invalid_batch_plan', 422)
      const inputs = item.inputs.map((reference) => {
        const stored = references.find(
          (one) => one.imageId === reference.imageId && one.mediaId === reference.mediaId,
        )
        if (!stored) throw new BatchPlanError('invalid_batch_plan', 422)
        return stored
      })
      return {
        key: item.key,
        kind: 'generation',
        ordinal,
        prompt: item.prompt,
        dependencies: item.dependencies,
        params: item.params,
        inputs,
      }
    })
    const mediaIds = [
      ...new Set(items.flatMap((item) => item.inputs.map((reference) => reference.mediaId))),
    ]
    const ready = await tx
      .select({ id: schema.media_objects.id })
      .from(schema.media_objects)
      .where(
        and(
          eq(schema.media_objects.user_id, userId),
          eq(schema.media_objects.status, 'ready'),
          inArray(schema.media_objects.id, mediaIds),
        ),
      )
    if (ready.length !== mediaIds.length) throw new BatchPlanError('invalid_batch_plan', 422)
    const estimate = await quoteBatchPlan(tx, userId, items)
    const version = batch.current_version + 1
    const now = Date.now()
    const digest = createHash('sha256')
      .update(JSON.stringify({ title: input.title, rule: input.rule, items, estimate }))
      .digest('hex')
    await tx.insert(schema.agent_batch_plans).values({
      batch_id: id,
      version,
      title: input.title,
      rule: input.rule,
      digest,
      item_count: items.length,
      estimate_snapshot: estimate,
      created_at: now,
    })
    await tx
      .insert(schema.agent_batch_items)
      .values(items.map((item) => ({ ...item, batch_id: id, version })))
    await tx
      .update(schema.agent_batches)
      .set({ current_version: version, updated_at: now })
      .where(eq(schema.agent_batches.id, id))
    await tx
      .delete(schema.media_references)
      .where(
        and(
          eq(schema.media_references.owner_kind, 'batch'),
          eq(schema.media_references.owner_id, id),
          eq(schema.media_references.user_id, userId),
        ),
      )
    await tx.insert(schema.media_references).values(
      mediaIds.map((mediaId) => ({
        user_id: userId,
        media_id: mediaId,
        owner_kind: 'batch' as const,
        owner_id: id,
        created_at: now,
      })),
    )
  })
}

export async function cancelAgentBatchPlan(
  userId: string,
  id: string,
  expectedVersion: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [origin] = await tx
      .select({ conversationId: schema.agent_batches.conversation_id })
      .from(schema.agent_batches)
      .where(and(eq(schema.agent_batches.id, id), eq(schema.agent_batches.user_id, userId)))
    if (!origin?.conversationId) throw new BatchPlanError('batch_not_found', 404)
    // lockConversation acquires media owner, then conversation; the batch row is always last.
    await lockConversation(tx, origin.conversationId, userId)
    const [batch] = await tx
      .select()
      .from(schema.agent_batches)
      .where(and(eq(schema.agent_batches.id, id), eq(schema.agent_batches.user_id, userId)))
      .for('update')
    if (!batch || batch.conversation_id !== origin.conversationId)
      throw new BatchPlanError('batch_not_found', 404)
    const [conversation] = await tx
      .select({ id: schema.agent_conversations.id })
      .from(schema.agent_conversations)
      .where(
        and(
          eq(schema.agent_conversations.id, batch.conversation_id),
          isNull(schema.agent_conversations.deleted_at),
        ),
      )
    if (!conversation) throw new BatchPlanError('batch_not_found', 404)
    if (
      (batch.status !== 'draft' && batch.status !== 'cancelled') ||
      batch.current_version !== expectedVersion
    )
      throw new BatchPlanError('batch_version_conflict', 409)
    await tx
      .update(schema.agent_batches)
      .set({ status: 'cancelled', updated_at: Date.now() })
      .where(eq(schema.agent_batches.id, id))
    await tx
      .delete(schema.media_references)
      .where(
        and(
          eq(schema.media_references.owner_kind, 'batch'),
          eq(schema.media_references.owner_id, id),
          eq(schema.media_references.user_id, userId),
        ),
      )
  })
}

/** Drafts have no execution or billing evidence; deleting their conversation removes the plan too. */
export async function discardConversationBatchDrafts(
  conversationId: string,
  tx: BffTransaction,
): Promise<void> {
  const batches = await tx
    .select({ id: schema.agent_batches.id })
    .from(schema.agent_batches)
    .where(
      and(
        eq(schema.agent_batches.conversation_id, conversationId),
        inArray(schema.agent_batches.status, ['draft', 'cancelled']),
      ),
    )
    .for('update')
  if (!batches.length) return
  const ids = batches.map((batch) => batch.id)
  await tx
    .delete(schema.media_references)
    .where(
      and(
        eq(schema.media_references.owner_kind, 'batch'),
        inArray(schema.media_references.owner_id, ids),
      ),
    )
  await tx.delete(schema.agent_batches).where(inArray(schema.agent_batches.id, ids))
}

async function quoteBatchPlan(
  tx: BffTransaction,
  userId: string,
  items: readonly AgentBatchItem[],
): Promise<AgentBatchEstimates> {
  if (!isCapabilityEnabled('billing:credits'))
    return { analysis: emptyEstimate, generation: emptyEstimate }
  const { taskHooks } = await loadPrivateBffOverlay()
  const unavailable: AgentBatchEstimates = {
    analysis: emptyEstimate,
    generation: { status: 'unavailable', reason: 'price_unavailable' },
  }
  if (!taskHooks.quoteTask) return unavailable
  const quotes = new Map<
    string,
    { estimatedCredits: number; pricing: AgentBatchPriceSnapshot } | null
  >()
  const snapshots: AgentBatchPriceSnapshot[] = []
  let estimatedCredits = 0
  for (const item of items) {
    if (!quotes.has(item.params.model))
      quotes.set(
        item.params.model,
        await taskHooks.quoteTask({
          tx,
          userId,
          model: item.params.model,
          quantity: 1,
          unitMultiplier: 1,
        }),
      )
    const quote = quotes.get(item.params.model)
    if (!quote) return unavailable
    estimatedCredits += quote.estimatedCredits
    snapshots.push({ ...quote.pricing, itemKey: item.key })
  }
  return {
    analysis: emptyEstimate,
    generation: {
      status: 'available',
      estimatedCredits,
      estimatedChargeCredits: estimatedCredits,
      snapshots,
    },
  }
}

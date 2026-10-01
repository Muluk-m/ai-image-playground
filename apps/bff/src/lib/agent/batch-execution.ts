import { createHash } from 'node:crypto'
import type {
  AgentBatchEstimates,
  AgentBatchItem,
  AgentBatchPriceSnapshot,
} from '@image-playground/shared'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { config } from '../../config'
import { db, schema } from '../../db/client'
import { isCapabilityEnabled } from '../capabilities'
import { type BffTransaction, loadPrivateBffOverlay } from '../private-overlay'
import {
  type CreateQueueTaskInput,
  createQueueTask,
  discardQueueTaskPreparation,
  prepareQueueTask,
} from '../taskSubmission'
import { BatchPlanError, batchPlansAvailable } from './batch-plans'
import { lockConversation } from './confirmations'
import { readConversationMedia } from './images'
import { shapeQueuePrompt } from './prompt-shaping'
import { queueParamsFor } from './tools/queueParams'
import { resolveAgentModel } from './tools/queueTask'

export function batchExecutionAvailable(userId: string) {
  return (
    batchPlansAvailable({ userId }) &&
    isCapabilityEnabled('agent:batch-execution') &&
    config.operator.quotas['agent:batch-max-items'] > 0 &&
    config.operator.quotas['agent:batch-dispatch-window'] > 0
  )
}

type BatchRow = typeof schema.agent_batches.$inferSelect

async function lockOwnedBatch(tx: BffTransaction, userId: string, id: string) {
  const [origin] = await tx
    .select()
    .from(schema.agent_batches)
    .where(and(eq(schema.agent_batches.id, id), eq(schema.agent_batches.user_id, userId)))
  if (!origin?.conversation_id) throw new BatchPlanError('batch_not_found', 404)
  await lockConversation(tx, origin.conversation_id, userId)
  const [batch] = await tx
    .select()
    .from(schema.agent_batches)
    .where(eq(schema.agent_batches.id, id))
    .for('update')
  const [conversation] = await tx
    .select({ id: schema.agent_conversations.id })
    .from(schema.agent_conversations)
    .where(
      and(
        eq(schema.agent_conversations.id, origin.conversation_id),
        eq(schema.agent_conversations.user_id, userId),
        isNull(schema.agent_conversations.deleted_at),
      ),
    )
  if (!batch || !conversation || batch.conversation_id !== origin.conversation_id)
    throw new BatchPlanError('batch_not_found', 404)
  return batch
}

export async function confirmAgentBatch(
  userId: string,
  id: string,
  input: {
    commandId: string
    expectedVersion: number
    expectedDigest: string
    deviceId: string
  },
) {
  if (!batchExecutionAvailable(userId)) throw new BatchPlanError('batch_execution_unavailable', 422)
  await db.transaction(async (tx) => {
    const batch = await lockOwnedBatch(tx, userId, id)
    const [plan] = await tx
      .select()
      .from(schema.agent_batch_plans)
      .where(
        and(
          eq(schema.agent_batch_plans.batch_id, id),
          eq(schema.agent_batch_plans.version, batch.current_version),
        ),
      )
    if (!plan || plan.version !== input.expectedVersion || plan.digest !== input.expectedDigest)
      throw new BatchPlanError('batch_version_conflict', 409)
    if (batch.confirmed_version !== null) {
      if (batch.confirmed_version !== input.expectedVersion)
        throw new BatchPlanError('batch_version_conflict', 409)
      return
    }
    if (
      batch.status !== 'draft' &&
      !(batch.status === 'paused' && batch.pause_reason === 'price_changed')
    )
      throw new BatchPlanError('batch_version_conflict', 409)
    if (plan.item_count > config.operator.quotas['agent:batch-max-items'])
      throw new BatchPlanError('batch_size_exceeded', 422)
    if (plan.estimate_snapshot.generation.status !== 'available')
      throw new BatchPlanError('batch_price_changed', 409)
    await tx
      .update(schema.agent_batches)
      .set({
        status: 'running',
        pause_reason: null,
        confirmed_version: plan.version,
        confirmation_command_id: input.commandId,
        device_id: input.deviceId,
        dispatch_generation: batch.dispatch_generation + 1,
        updated_at: Date.now(),
      })
      .where(eq(schema.agent_batches.id, id))
  })
  await dispatchAgentBatch(userId, id)
}

async function batchAttempts(tx: typeof db | BffTransaction, batch: BatchRow) {
  return tx
    .select({ key: schema.agent_batch_attempts.item_key, status: schema.tasks.status })
    .from(schema.agent_batch_attempts)
    .leftJoin(schema.tasks, eq(schema.tasks.id, schema.agent_batch_attempts.task_id))
    .where(eq(schema.agent_batch_attempts.batch_id, batch.id))
}

function hasWindow(attempts: Awaited<ReturnType<typeof batchAttempts>>) {
  return (
    attempts.filter(
      (one) => !one.status || !['completed', 'failed', 'cancelled'].includes(one.status),
    ).length < config.operator.quotas['agent:batch-dispatch-window']
  )
}

async function prepareItem(batch: BatchRow, item: AgentBatchItem): Promise<CreateQueueTaskInput> {
  const images: string[] = []
  for (const reference of item.inputs) {
    const media = await readConversationMedia(
      reference.mediaId,
      batch.conversation_id!,
      batch.user_id,
      'original',
    )
    if (!media) throw new BatchPlanError('invalid_batch_plan', 422)
    images.push(`data:${media.contentType};base64,${Buffer.from(media.bytes).toString('base64')}`)
  }
  const params = queueParamsFor(item.params.provider, item.params)
  return {
    provider: item.params.provider,
    model: item.params.model,
    userId: batch.user_id,
    reconciliationRequired: true,
    request: {
      ...params,
      n: 1,
      prompt: shapeQueuePrompt({
        provider: item.params.provider,
        model: item.params.model,
        prompt: item.prompt,
        size: params.size,
      }),
      input_images: images,
      device_id: batch.device_id!,
      client_request_id: `batch:${batch.id}:${batch.confirmed_version}:${item.key}:1`,
    },
    agent: { conversationId: batch.conversation_id!, turnId: batch.origin_turn_id },
  }
}

async function currentQuote(
  tx: BffTransaction,
  batch: BatchRow,
  item: AgentBatchItem,
): Promise<{ pricing: AgentBatchPriceSnapshot | null; credits: number }> {
  if (!isCapabilityEnabled('billing:credits')) return { pricing: null, credits: 0 }
  const [plan] = await tx
    .select()
    .from(schema.agent_batch_plans)
    .where(
      and(
        eq(schema.agent_batch_plans.batch_id, batch.id),
        eq(schema.agent_batch_plans.version, batch.confirmed_version!),
      ),
    )
  const estimate = plan?.estimate_snapshot.generation
  const expected =
    estimate?.status === 'available'
      ? estimate.snapshots.find((one) => one.itemKey === item.key)
      : undefined
  const hooks = (await loadPrivateBffOverlay()).taskHooks
  // The quote hook holds the price row FOR SHARE until createQueueTask reserves in this transaction.
  const quote = await hooks.quoteTask?.({
    tx,
    userId: batch.user_id,
    model: item.params.model,
    quantity: 1,
    unitMultiplier: 1,
  })
  if (
    !expected ||
    !quote ||
    quote.pricing.pricingVersion !== expected.pricingVersion ||
    quote.estimatedCredits > expected.baseUnitCredits * expected.quantity * expected.unitMultiplier
  )
    throw new BatchPlanError('batch_price_changed', 409)
  return { pricing: { ...quote.pricing, itemKey: item.key }, credits: quote.estimatedCredits }
}

/** Each preparation is outside locks; commit rechecks the batch generation before accepting it. */
export async function dispatchAgentBatch(userId: string, id: string): Promise<void> {
  for (let slot = 0; slot < config.operator.quotas['agent:batch-dispatch-window']; slot++) {
    const [batch] = await db
      .select()
      .from(schema.agent_batches)
      .where(and(eq(schema.agent_batches.id, id), eq(schema.agent_batches.user_id, userId)))
    if (
      !batch?.conversation_id ||
      batch.status !== 'running' ||
      batch.confirmed_version === null ||
      !batchExecutionAvailable(userId)
    )
      return
    const attempts = await batchAttempts(db, batch)
    if (!hasWindow(attempts)) return
    const items = await db
      .select()
      .from(schema.agent_batch_items)
      .where(
        and(
          eq(schema.agent_batch_items.batch_id, id),
          eq(schema.agent_batch_items.version, batch.confirmed_version),
        ),
      )
      .orderBy(asc(schema.agent_batch_items.ordinal))
    const item = items.find(
      (one) =>
        !attempts.some((attempt) => attempt.key === one.key) &&
        one.dependencies.every((key) =>
          attempts.some((attempt) => attempt.key === key && attempt.status === 'completed'),
        ),
    )
    if (!item) return
    const input = await prepareItem(batch, item)
    const preparation = await prepareQueueTask(input)
    if (preparation.kind !== 'prepared') throw new BatchPlanError('invalid_batch_plan', 422)
    let committed = false
    try {
      committed = await db.transaction(async (tx) => {
        const current = await lockOwnedBatch(tx, userId, id)
        if (
          current.status !== 'running' ||
          current.dispatch_generation !== batch.dispatch_generation ||
          current.confirmed_version !== batch.confirmed_version ||
          !batchExecutionAvailable(userId)
        )
          return false
        const currentAttempts = await batchAttempts(tx, current)
        if (!hasWindow(currentAttempts) || currentAttempts.some((one) => one.key === item.key))
          return false
        const model = resolveAgentModel('image', item.params.model)
        if (!model || model.model !== item.params.model || model.provider !== item.params.provider)
          throw new BatchPlanError('batch_execution_unavailable', 422)
        const quote = await currentQuote(tx, current, item)
        const submitted = await createQueueTask({ ...input, prepared: preparation.prepared, tx })
        if (submitted.kind === 'insufficient_credits')
          throw new BatchPlanError('batch_insufficient_credits', 422)
        if (submitted.kind !== 'created') throw new BatchPlanError('batch_submission_refused', 422)
        await tx.insert(schema.agent_batch_attempts).values({
          batch_id: id,
          version: current.confirmed_version!,
          item_key: item.key,
          attempt: 1,
          task_id: submitted.taskId,
          price_snapshot: quote.pricing,
          reserved_credits: quote.credits,
          submitted_at: submitted.submittedAt,
        })
        return submitted.taskId === preparation.prepared.taskId
      })
    } catch (error) {
      if (!(error instanceof BatchPlanError)) throw error
      const pauseReason =
        error.code === 'batch_price_changed'
          ? 'price_changed'
          : error.code === 'batch_insufficient_credits'
            ? 'insufficient_credits'
            : null
      if (!pauseReason) throw error
      await db.transaction(async (tx) => {
        const current = await lockOwnedBatch(tx, userId, id)
        if (
          current.status === 'running' &&
          current.dispatch_generation === batch.dispatch_generation
        )
          await tx
            .update(schema.agent_batches)
            .set({
              status: 'paused',
              pause_reason: pauseReason,
              dispatch_generation: current.dispatch_generation + 1,
              updated_at: Date.now(),
            })
            .where(eq(schema.agent_batches.id, id))
      })
      return
    } finally {
      if (!committed) await discardQueueTaskPreparation(preparation.prepared)
    }
  }
}

export async function controlAgentBatch(
  userId: string,
  id: string,
  kind: 'pause' | 'resume',
  input: {
    commandId: string
    expectedVersion: number
    expectedDigest?: string
  },
) {
  if (kind === 'resume' && !batchExecutionAvailable(userId))
    throw new BatchPlanError('batch_execution_unavailable', 422)
  await db.transaction(async (tx) => {
    const batch = await lockOwnedBatch(tx, userId, id)
    const hash = createHash('sha256')
      .update(
        JSON.stringify({ kind, version: input.expectedVersion, digest: input.expectedDigest }),
      )
      .digest('hex')
    const [receipt] = await tx
      .select()
      .from(schema.agent_batch_commands)
      .where(
        and(
          eq(schema.agent_batch_commands.batch_id, id),
          eq(schema.agent_batch_commands.command_id, input.commandId),
        ),
      )
    if (receipt) {
      if (receipt.request_hash !== hash) throw new BatchPlanError('batch_version_conflict', 409)
      return
    }
    if (
      batch.confirmed_version !== input.expectedVersion ||
      !['running', 'paused'].includes(batch.status)
    )
      throw new BatchPlanError('batch_version_conflict', 409)
    if (kind === 'resume') {
      if (batch.pause_reason === 'price_changed')
        throw new BatchPlanError('batch_price_changed', 409)
      const [plan] = await tx
        .select({ digest: schema.agent_batch_plans.digest })
        .from(schema.agent_batch_plans)
        .where(
          and(
            eq(schema.agent_batch_plans.batch_id, id),
            eq(schema.agent_batch_plans.version, input.expectedVersion),
          ),
        )
      if (!plan || plan.digest !== input.expectedDigest)
        throw new BatchPlanError('batch_version_conflict', 409)
    }
    const target = kind === 'pause' ? 'paused' : 'running'
    if (batch.status !== target)
      await tx
        .update(schema.agent_batches)
        .set({
          status: target,
          pause_reason: target === 'running' ? null : batch.pause_reason,
          dispatch_generation: batch.dispatch_generation + 1,
          updated_at: Date.now(),
        })
        .where(eq(schema.agent_batches.id, id))
    await tx.insert(schema.agent_batch_commands).values({
      batch_id: id,
      command_id: input.commandId,
      kind,
      request_hash: hash,
      created_at: Date.now(),
    })
  })
  if (kind === 'resume') await dispatchAgentBatch(userId, id)
}

/** Requote only work without an accepted task; historical attempts retain their original facts. */
export async function repriceAgentBatch(
  userId: string,
  id: string,
  input: { commandId: string; expectedVersion: number },
) {
  if (!batchExecutionAvailable(userId)) throw new BatchPlanError('batch_execution_unavailable', 422)
  await db.transaction(async (tx) => {
    const batch = await lockOwnedBatch(tx, userId, id)
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ kind: 'reprice', version: input.expectedVersion }))
      .digest('hex')
    const [receipt] = await tx
      .select()
      .from(schema.agent_batch_commands)
      .where(
        and(
          eq(schema.agent_batch_commands.batch_id, id),
          eq(schema.agent_batch_commands.command_id, input.commandId),
        ),
      )
    if (receipt) {
      if (receipt.request_hash !== requestHash)
        throw new BatchPlanError('batch_version_conflict', 409)
      return
    }
    if (
      batch.current_version !== input.expectedVersion ||
      batch.status !== 'paused' ||
      batch.pause_reason !== 'price_changed'
    )
      throw new BatchPlanError('batch_version_conflict', 409)
    const [plan] = await tx
      .select()
      .from(schema.agent_batch_plans)
      .where(
        and(
          eq(schema.agent_batch_plans.batch_id, id),
          eq(schema.agent_batch_plans.version, batch.current_version),
        ),
      )
    if (!plan) throw new BatchPlanError('batch_not_found', 404)
    const items = await tx
      .select()
      .from(schema.agent_batch_items)
      .where(
        and(
          eq(schema.agent_batch_items.batch_id, id),
          eq(schema.agent_batch_items.version, batch.current_version),
        ),
      )
      .orderBy(asc(schema.agent_batch_items.ordinal))
    const attempts = await tx
      .select()
      .from(schema.agent_batch_attempts)
      .where(eq(schema.agent_batch_attempts.batch_id, id))
    const hooks = (await loadPrivateBffOverlay()).taskHooks
    const snapshots: AgentBatchPriceSnapshot[] = []
    let estimatedCredits = 0
    for (const item of items) {
      const accepted = attempts.find((one) => one.item_key === item.key)
      if (accepted) {
        estimatedCredits += accepted.reserved_credits
        if (accepted.price_snapshot) snapshots.push(accepted.price_snapshot)
        continue
      }
      if (!isCapabilityEnabled('billing:credits')) continue
      const quote = await hooks.quoteTask?.({
        tx,
        userId,
        model: item.params.model,
        quantity: 1,
        unitMultiplier: 1,
      })
      if (!quote) throw new BatchPlanError('batch_price_changed', 409)
      estimatedCredits += quote.estimatedCredits
      snapshots.push({ ...quote.pricing, itemKey: item.key })
    }
    const estimate: AgentBatchEstimates = {
      analysis: plan.estimate_snapshot.analysis,
      generation: {
        status: 'available',
        estimatedCredits,
        estimatedChargeCredits: estimatedCredits,
        snapshots,
      },
    }
    const version = batch.current_version + 1
    const now = Date.now()
    const content = items.map(({ batch_id: _batch, version: _version, ...item }) => item)
    const digest = createHash('sha256')
      .update(JSON.stringify({ title: plan.title, rule: plan.rule, items: content, estimate }))
      .digest('hex')
    await tx.insert(schema.agent_batch_plans).values({
      batch_id: id,
      version,
      title: plan.title,
      rule: plan.rule,
      digest,
      item_count: plan.item_count,
      estimate_snapshot: estimate,
      created_at: now,
    })
    await tx
      .insert(schema.agent_batch_items)
      .values(content.map((item) => ({ ...item, batch_id: id, version })))
    await tx
      .update(schema.agent_batches)
      .set({
        current_version: version,
        confirmed_version: null,
        dispatch_generation: batch.dispatch_generation + 1,
        updated_at: now,
      })
      .where(eq(schema.agent_batches.id, id))
    await tx.insert(schema.agent_batch_commands).values({
      batch_id: id,
      command_id: input.commandId,
      kind: 'reprice',
      request_hash: requestHash,
      created_at: now,
    })
  })
}

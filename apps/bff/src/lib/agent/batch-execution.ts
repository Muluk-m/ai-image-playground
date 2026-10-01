import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  type AgentBatchEstimates,
  type AgentBatchGenerationItem,
  type AgentBatchItem,
  type AgentBatchPriceSnapshot,
  QUEUE_MAX_INPUT_IMAGES,
} from '@image-playground/shared'
import { and, asc, eq, gt, inArray, isNotNull, isNull, or } from 'drizzle-orm'
import { config } from '../../config'
import { db, schema } from '../../db/client'
import {
  type PreparedAnalysisTask,
  prepareAnalysisTask,
  quoteAnalysisTask,
  reserveAnalysisTask,
} from '../analysis-tasks'
import { isCapabilityEnabled } from '../capabilities'
import { log } from '../logger'
import { type BffTransaction, loadPrivateBffOverlay } from '../private-overlay'
import { SafeFetchError } from '../safeFetch'
import {
  type CreateQueueTaskInput,
  createQueueTask,
  discardQueueTaskPreparation,
  type PreparedQueueTask,
  prepareQueueTask,
} from '../taskSubmission'
import { cancelledBatchDependents, readFrozenDependencyTargets } from './batch-dependencies'
import { batchItem, batchItemValues } from './batch-items'
import { BatchPlanError, batchPlansAvailable, quoteBatchPlan } from './batch-plans'
import { pauseBatchForAnalysisAuthentication, reconcileAgentBatchProgress } from './batch-progress'
import { lockConversation } from './confirmations'
import { type ResolvedAgentImage, readConversationMedia } from './images'
import { prepareMaskedEdit } from './masked-edit'
import { shapeQueuePrompt } from './prompt-shaping'
import { imageSelection } from './selection-preview'
import { AgentToolError } from './tools/errors'
import { queueParamsFor } from './tools/queueParams'
import { resolveAgentModel } from './tools/queueTask'
import { visualByteLimit, visualMetadata, withVisualPreparation } from './visual-resources'

export function batchExecutionAvailable(userId: string) {
  return (
    batchPlansAvailable({ userId }) &&
    isCapabilityEnabled('agent:batch-execution') &&
    config.operator.quotas['agent:batch-max-items'] > 0 &&
    config.operator.quotas['agent:batch-dispatch-window'] > 0
  )
}

type BatchRow = typeof schema.agent_batches.$inferSelect

export async function lockOwnedBatch(tx: BffTransaction, userId: string, id: string) {
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
    // The owner lock serializes confirmations across this account's batches.
    const [commandOwner] = await tx
      .select({ id: schema.agent_batches.id })
      .from(schema.agent_batches)
      .where(
        and(
          eq(schema.agent_batches.user_id, userId),
          eq(schema.agent_batches.confirmation_command_id, input.commandId),
        ),
      )
    if (commandOwner && commandOwner.id !== id)
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
    if (!plan || plan.version !== input.expectedVersion || plan.digest !== input.expectedDigest)
      throw new BatchPlanError('batch_version_conflict', 409)
    if (batch.confirmed_version !== null) {
      if (batch.confirmed_version !== input.expectedVersion)
        throw new BatchPlanError('batch_version_conflict', 409)
      return
    }
    if (
      batch.status !== 'draft' &&
      !(
        batch.status === 'paused' &&
        (batch.pause_reason === 'price_changed' ||
          plan.retry_item_keys.length > 0 ||
          plan.confirmation !== null)
      )
    )
      throw new BatchPlanError('batch_version_conflict', 409)
    if (plan.item_count > config.operator.quotas['agent:batch-max-items'])
      throw new BatchPlanError('batch_size_exceeded', 422)
    const items = await tx
      .select({ inputs: schema.agent_batch_items.inputs, kind: schema.agent_batch_items.kind })
      .from(schema.agent_batch_items)
      .where(
        and(
          eq(schema.agent_batch_items.batch_id, id),
          eq(schema.agent_batch_items.version, plan.version),
        ),
      )
    if (items.some((item) => plan.estimate_snapshot[item.kind].status !== 'available'))
      throw new BatchPlanError('batch_price_changed', 409)
    if (
      items.some((item) => item.kind === 'analysis') &&
      !isCapabilityEnabled('agent:batch-analysis')
    )
      throw new BatchPlanError('batch_execution_unavailable', 422)
    if (
      items.some(
        (item) => item.kind === 'generation' && item.inputs.length > QUEUE_MAX_INPUT_IMAGES,
      )
    )
      throw new BatchPlanError('batch_input_limit', 422)
    await tx
      .update(schema.agent_batches)
      .set({
        status:
          plan.retry_requires_resume || plan.confirmation?.requiresResume ? 'paused' : 'running',
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
  const rows = await tx
    .select({
      key: schema.agent_batch_attempts.item_key,
      attempt: schema.agent_batch_attempts.attempt,
      status: schema.tasks.status,
      upstreamStatus: schema.tasks.upstream_status,
      errorType: schema.tasks.error_type,
      snapshot: schema.agent_batch_attempts.terminal_snapshot,
    })
    .from(schema.agent_batch_attempts)
    .leftJoin(schema.tasks, eq(schema.tasks.id, schema.agent_batch_attempts.task_id))
    .where(eq(schema.agent_batch_attempts.batch_id, batch.id))
  return rows.map((row) => ({
    key: row.key,
    attempt: row.attempt,
    status:
      row.snapshot?.errorCode === 'result_unknown'
        ? 'reconciling'
        : (row.snapshot?.status ?? row.status),
    unrecordedAuthenticationFailure:
      !row.snapshot &&
      row.status === 'failed' &&
      row.errorType !== 'content_policy' &&
      (row.upstreamStatus === 401 || row.upstreamStatus === 403),
  }))
}

function hasWindow(attempts: Awaited<ReturnType<typeof batchAttempts>>) {
  return (
    attempts.filter(
      (one) => !one.status || !['completed', 'failed', 'cancelled'].includes(one.status),
    ).length < config.operator.quotas['agent:batch-dispatch-window']
  )
}

async function prepareItem(
  batch: BatchRow,
  item: AgentBatchGenerationItem,
  attempt: number,
): Promise<CreateQueueTaskInput> {
  const images: ResolvedAgentImage[] = []
  let remainingBytes = visualByteLimit()
  const readInput = async (mediaId: string) => {
    const media = await readConversationMedia(
      mediaId,
      batch.conversation_id!,
      batch.user_id,
      'original',
      false,
      Math.floor((remainingBytes * 3) / 4),
    )
    if (!media) throw new BatchPlanError('invalid_batch_plan', 422)
    await visualMetadata(media.bytes)
    const dataUrl = `data:${media.contentType};base64,${Buffer.from(media.bytes).toString('base64')}`
    remainingBytes -= Buffer.byteLength(dataUrl, 'utf8')
    if (remainingBytes < 0) throw new BatchPlanError('batch_input_limit', 422)
    return dataUrl
  }
  for (const reference of item.inputs) {
    const dataUrl = await readInput(reference.mediaId)
    const maskDataUrl = reference.maskMediaId ? await readInput(reference.maskMediaId) : undefined
    images.push({
      imageId: reference.imageId,
      dataUrl,
      ...(maskDataUrl ? { maskDataUrl } : {}),
      ...(reference.editAction ? { editAction: reference.editAction } : {}),
      ...(reference.regions ? { regions: reference.regions } : {}),
    })
  }
  const bindings = []
  for (const image of images) {
    const selection = await imageSelection(image, false)
    if (selection) bindings.push({ imageId: image.imageId, selectionId: selection.id })
  }
  // Confirmation authorized this exact prompt and immutable selection; later conversation edits do not replace either.
  const masked = await prepareMaskedEdit(images, bindings, item.prompt)
  const inputImages = masked?.inputImages ?? images.map((image) => image.dataUrl)
  const preparedBytes =
    inputImages.reduce((sum, source) => sum + Buffer.byteLength(source, 'utf8'), 0) +
    Buffer.byteLength(masked?.mask ?? '', 'utf8')
  if (preparedBytes > visualByteLimit()) throw new BatchPlanError('batch_input_limit', 422)
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
        prompt: masked?.prompt ?? item.prompt,
        size: params.size,
      }),
      input_images: inputImages,
      ...(masked?.mask ? { mask: masked.mask } : {}),
      device_id: batch.device_id!,
      client_request_id: `batch:${batch.id}:${batch.confirmed_version}:${item.key}:${attempt}`,
    },
    agent: { conversationId: batch.conversation_id!, turnId: batch.origin_turn_id },
  }
}

async function currentQuote(
  tx: BffTransaction,
  batch: BatchRow,
  item: AgentBatchItem,
): Promise<{ pricing: AgentBatchPriceSnapshot | null; credits: number }> {
  if (item.kind === 'generation' && !isCapabilityEnabled('billing:credits'))
    return { pricing: null, credits: 0 }
  const [plan] = await tx
    .select()
    .from(schema.agent_batch_plans)
    .where(
      and(
        eq(schema.agent_batch_plans.batch_id, batch.id),
        eq(schema.agent_batch_plans.version, batch.confirmed_version!),
      ),
    )
  const estimate = plan?.estimate_snapshot[item.kind]
  const expected =
    estimate?.status === 'available'
      ? estimate.snapshots.find((one) => one.itemKey === item.key)
      : undefined
  const hooks = (await loadPrivateBffOverlay()).taskHooks
  // The quote hook holds the price row FOR SHARE until createQueueTask reserves in this transaction.
  const quote =
    item.kind === 'analysis'
      ? await quoteAnalysisTask(
          {
            tx,
            userId: batch.user_id,
            model: item.params.model,
            estimatedInputTokens: item.params.estimatedInputTokens,
          },
          hooks,
        )
      : await hooks.quoteTask?.({
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
    quote.estimatedCredits >
      Math.ceil(expected.baseUnitCredits * expected.quantity * expected.unitMultiplier)
  )
    throw new BatchPlanError('batch_price_changed', 409)
  return { pricing: { ...quote.pricing, itemKey: item.key }, credits: quote.estimatedCredits }
}

/** Each preparation is outside locks; commit rechecks the batch generation before accepting it. */
/** A rotating bounded page prevents unresolved batches from starving later confirmations. */
export async function advanceAgentBatches(
  afterId: string | null,
  canDispatch: () => boolean,
): Promise<string | null> {
  if (!canDispatch()) return afterId
  const batches = await db
    .select({ id: schema.agent_batches.id, userId: schema.agent_batches.user_id })
    .from(schema.agent_batches)
    .where(
      and(
        inArray(schema.agent_batches.status, ['running', 'paused']),
        or(
          isNotNull(schema.agent_batches.confirmed_version),
          isNull(schema.agent_batches.conversation_id),
        ),
        afterId ? gt(schema.agent_batches.id, afterId) : undefined,
      ),
    )
    .orderBy(asc(schema.agent_batches.id))
    .limit(8)
  let cursor = afterId
  for (const batch of batches) {
    if (!canDispatch()) return cursor
    try {
      await reconcileAgentBatchProgress(batch.id)
      if (isCapabilityEnabled('agent:batch-execution'))
        await dispatchAgentBatch(batch.userId, batch.id, canDispatch)
    } catch (error) {
      log.error(
        {
          event: 'agent.batch_dispatch_failed',
          batchId: batch.id,
          err: error instanceof Error ? error.message : String(error),
        },
        'batch dispatch failed',
      )
    }
    cursor = batch.id
  }
  return batches.length < 8 ? null : cursor
}

export async function dispatchAgentBatch(
  userId: string,
  id: string,
  canDispatch: () => boolean = () => true,
): Promise<void> {
  if (!canDispatch()) return
  return withVisualPreparation(() => dispatchPreparedBatch(userId, id, canDispatch))
}

async function dispatchPreparedBatch(
  userId: string,
  id: string,
  canDispatch: () => boolean,
): Promise<void> {
  for (let slot = 0; slot < config.operator.quotas['agent:batch-dispatch-window']; slot++) {
    if (!canDispatch()) return
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
      .then((rows) => rows.map(batchItem))
    const [plan] = await db
      .select()
      .from(schema.agent_batch_plans)
      .where(
        and(
          eq(schema.agent_batch_plans.batch_id, id),
          eq(schema.agent_batch_plans.version, batch.confirmed_version),
        ),
      )
    if (!plan) return
    const targetAttempt = (key: string) =>
      Object.hasOwn(plan.attempt_targets, key) ? plan.attempt_targets[key]! : 1
    const item = items.find(
      (one) =>
        !attempts.some(
          (attempt) => attempt.key === one.key && attempt.attempt === targetAttempt(one.key),
        ) &&
        one.dependencies.every((key) =>
          attempts.some(
            (attempt) =>
              attempt.key === key &&
              attempt.attempt === targetAttempt(key) &&
              attempt.status === 'completed',
          ),
        ),
    )
    if (!item) return
    let prepared: PreparedQueueTask | undefined
    let preparedAnalysis: PreparedAnalysisTask | undefined
    let input: CreateQueueTaskInput | undefined
    let committed = false
    try {
      if (item.kind === 'analysis') {
        if (
          !isCapabilityEnabled('agent:batch-analysis') ||
          item.params.model !== config.agent.model
        )
          throw new BatchPlanError('batch_execution_unavailable', 422)
        preparedAnalysis = await prepareAnalysisTask({
          userId,
          model: item.params.model,
          prompt: item.prompt,
          inputs: item.inputs,
          intent: item.params.intent,
        })
        if (
          preparedAnalysis.estimatedInputTokens !== item.params.estimatedInputTokens ||
          !isDeepStrictEqual(preparedAnalysis.evidence, item.params.evidence)
        )
          throw new BatchPlanError('batch_input_limit', 422)
      } else {
        input = await prepareItem(batch, item, targetAttempt(item.key))
        if (!canDispatch()) return
        const preparation = await prepareQueueTask(input)
        if (preparation.kind !== 'prepared') throw new BatchPlanError('invalid_batch_plan', 422)
        prepared = preparation.prepared
      }
      committed = await db.transaction(async (tx) => {
        const current = await lockOwnedBatch(tx, userId, id)
        if (
          !canDispatch() ||
          current.status !== 'running' ||
          current.dispatch_generation !== batch.dispatch_generation ||
          current.confirmed_version !== batch.confirmed_version ||
          !batchExecutionAvailable(userId)
        )
          return false
        if (await pauseBatchForAnalysisAuthentication(tx, current)) return false
        const currentAttempts = await batchAttempts(tx, current)
        // A task may fail while this item's bytes are being prepared, after the last progress scan.
        if (currentAttempts.some((one) => one.unrecordedAuthenticationFailure)) {
          await tx
            .update(schema.agent_batches)
            .set({
              status: 'paused',
              pause_reason: 'upstream_auth',
              dispatch_generation: current.dispatch_generation + 1,
              updated_at: Date.now(),
            })
            .where(eq(schema.agent_batches.id, id))
          return false
        }
        if (
          !hasWindow(currentAttempts) ||
          currentAttempts.some(
            (one) => one.key === item.key && one.attempt === targetAttempt(item.key),
          )
        )
          return false
        if (item.kind === 'generation') {
          const model = resolveAgentModel('image', item.params.model)
          if (
            !model ||
            model.model !== item.params.model ||
            model.provider !== item.params.provider
          )
            throw new BatchPlanError('batch_execution_unavailable', 422)
        } else if (
          !isCapabilityEnabled('agent:batch-analysis') ||
          item.params.model !== config.agent.model
        )
          throw new BatchPlanError('batch_execution_unavailable', 422)
        const quote = await currentQuote(tx, current, item)
        let taskId: string
        let submittedAt: number
        let reservedCredits: number
        if (item.kind === 'analysis') {
          if (!preparedAnalysis || !quote.pricing)
            throw new BatchPlanError('batch_price_changed', 409)
          taskId = crypto.randomUUID()
          submittedAt = Date.now()
          const reservation = await reserveAnalysisTask({
            tx,
            taskHooks: (await loadPrivateBffOverlay()).taskHooks,
            taskId,
            userId,
            deviceId: current.device_id!,
            batchId: id,
            version: current.confirmed_version!,
            itemKey: item.key,
            attempt: targetAttempt(item.key),
            originConversationId: current.conversation_id,
            originTurnId: current.origin_turn_id,
            prepared: preparedAnalysis,
            pricing: quote.pricing,
          })
          if (reservation.kind === 'insufficient_credits')
            throw new BatchPlanError('batch_insufficient_credits', 422)
          if (reservation.kind !== 'reserved')
            throw new BatchPlanError('batch_submission_refused', 422)
          reservedCredits = reservation.credits
        } else {
          if (!input || !prepared) throw new BatchPlanError('invalid_batch_plan', 422)
          const submitted = await createQueueTask({ ...input, prepared, tx })
          if (submitted.kind === 'insufficient_credits')
            throw new BatchPlanError('batch_insufficient_credits', 422)
          if (submitted.kind !== 'created')
            throw new BatchPlanError('batch_submission_refused', 422)
          taskId = submitted.taskId
          submittedAt = submitted.submittedAt
          reservedCredits = quote.credits
        }
        await tx.insert(schema.agent_batch_attempts).values({
          batch_id: id,
          version: current.confirmed_version!,
          item_key: item.key,
          attempt: targetAttempt(item.key),
          task_id: taskId,
          price_snapshot: quote.pricing,
          reserved_credits: reservedCredits,
          submitted_at: submittedAt,
        })
        return item.kind === 'analysis' || taskId === prepared?.taskId
      })
    } catch (error) {
      const inputLimit =
        (error instanceof SafeFetchError && error.code === 'too_large') ||
        (error instanceof AgentToolError &&
          ['quota_exceeded', 'invalid_params'].includes(error.code)) ||
        (error instanceof BatchPlanError && error.code === 'batch_input_limit')
      const pauseReason = inputLimit
        ? 'input_limit'
        : error instanceof BatchPlanError && error.code === 'batch_price_changed'
          ? 'price_changed'
          : error instanceof BatchPlanError && error.code === 'batch_insufficient_credits'
            ? 'insufficient_credits'
            : error instanceof BatchPlanError && error.code === 'batch_execution_unavailable'
              ? 'model_unavailable'
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
      if (!committed && prepared) await discardQueueTaskPreparation(prepared)
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
      .then((rows) => rows.map(batchItem))
    const attempts = await tx
      .select()
      .from(schema.agent_batch_attempts)
      .where(eq(schema.agent_batch_attempts.batch_id, id))
    const hooks = (await loadPrivateBffOverlay()).taskHooks
    const snapshots: Record<AgentBatchItem['kind'], AgentBatchPriceSnapshot[]> = {
      analysis: [],
      generation: [],
    }
    const totals = { analysis: 0, generation: 0 }
    const charges = { analysis: 0, generation: 0 }
    for (const item of items) {
      const accepted = attempts.find(
        (one) =>
          one.item_key === item.key &&
          one.attempt ===
            (Object.hasOwn(plan.attempt_targets, item.key) ? plan.attempt_targets[item.key]! : 1),
      )
      if (accepted) {
        if (!plan.confirmation) {
          totals[item.kind] += accepted.reserved_credits
          charges[item.kind] += accepted.reserved_credits
        }
        if (accepted.price_snapshot) snapshots[item.kind].push(accepted.price_snapshot)
        continue
      }
      if (item.kind === 'generation' && !isCapabilityEnabled('billing:credits')) continue
      const quote =
        item.kind === 'analysis'
          ? await quoteAnalysisTask(
              {
                tx,
                userId,
                model: item.params.model,
                estimatedInputTokens: item.params.estimatedInputTokens,
              },
              hooks,
            )
          : await hooks.quoteTask?.({
              tx,
              userId,
              model: item.params.model,
              quantity: 1,
              unitMultiplier: 1,
            })
      if (!quote) throw new BatchPlanError('batch_price_changed', 409)
      totals[item.kind] += quote.estimatedCredits
      charges[item.kind] += quote.pricing.exemption === 'none' ? quote.estimatedCredits : 0
      snapshots[item.kind].push({ ...quote.pricing, itemKey: item.key })
    }
    const estimate: AgentBatchEstimates = {
      analysis: {
        status: 'available',
        estimatedCredits: totals.analysis,
        estimatedChargeCredits: charges.analysis,
        snapshots: snapshots.analysis,
      },
      generation: {
        status: 'available',
        estimatedCredits: totals.generation,
        estimatedChargeCredits: charges.generation,
        snapshots: snapshots.generation,
      },
    }
    const version = batch.current_version + 1
    const now = Date.now()
    const content = items
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          title: plan.title,
          rule: plan.rule,
          items: content,
          estimate,
          targets: plan.attempt_targets,
          confirmation: plan.confirmation,
        }),
      )
      .digest('hex')
    await tx.insert(schema.agent_batch_plans).values({
      batch_id: id,
      version,
      title: plan.title,
      rule: plan.rule,
      digest,
      item_count: plan.item_count,
      estimate_snapshot: estimate,
      attempt_targets: plan.attempt_targets,
      retry_item_keys: plan.retry_item_keys,
      retry_requires_resume: plan.retry_requires_resume,
      confirmation: plan.confirmation,
      created_at: now,
    })
    await tx
      .insert(schema.agent_batch_items)
      .values(content.map((item) => ({ ...batchItemValues(item), batch_id: id, version })))
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

/** A retry authorizes new attempt numbers; every earlier task and bill remains immutable. */
export async function quoteAgentBatchRetry(
  userId: string,
  id: string,
  input: { commandId: string; expectedVersion: number; itemKeys: string[] },
): Promise<void> {
  if (!batchExecutionAvailable(userId)) throw new BatchPlanError('batch_execution_unavailable', 422)
  const [owned] = await db
    .select({ id: schema.agent_batches.id })
    .from(schema.agent_batches)
    .where(
      and(
        eq(schema.agent_batches.id, id),
        eq(schema.agent_batches.user_id, userId),
        isNotNull(schema.agent_batches.conversation_id),
      ),
    )
  if (!owned) throw new BatchPlanError('batch_not_found', 404)
  await reconcileAgentBatchProgress(id)
  await db.transaction(async (tx) => {
    const batch = await lockOwnedBatch(tx, userId, id)
    const keys = [...new Set(input.itemKeys)].sort()
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ kind: 'retry_quote', version: input.expectedVersion, keys }))
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
      !keys.length ||
      batch.current_version !== input.expectedVersion ||
      batch.confirmed_version !== input.expectedVersion
    )
      throw new BatchPlanError('batch_version_conflict', 409)
    const [plan] = await tx
      .select()
      .from(schema.agent_batch_plans)
      .where(
        and(
          eq(schema.agent_batch_plans.batch_id, id),
          eq(schema.agent_batch_plans.version, input.expectedVersion),
        ),
      )
    if (!plan) throw new BatchPlanError('batch_not_found', 404)
    const items = await tx
      .select()
      .from(schema.agent_batch_items)
      .where(
        and(
          eq(schema.agent_batch_items.batch_id, id),
          eq(schema.agent_batch_items.version, input.expectedVersion),
        ),
      )
      .orderBy(asc(schema.agent_batch_items.ordinal))
      .then((rows) => rows.map(batchItem))
    const attempts = await tx
      .select()
      .from(schema.agent_batch_attempts)
      .where(eq(schema.agent_batch_attempts.batch_id, id))
    let targets = { ...plan.attempt_targets }
    for (const key of keys) {
      const item = items.find((one) => one.key === key)
      const latest = attempts
        .filter((one) => one.item_key === key)
        .sort((a, b) => b.attempt - a.attempt)[0]
      if (
        !item ||
        !latest ||
        latest.attempt !== (Object.hasOwn(targets, key) ? targets[key]! : 1) ||
        latest.terminal_snapshot?.status !== 'failed' ||
        latest.terminal_snapshot.errorCode === 'result_unknown'
      )
        throw new BatchPlanError('batch_retry_unavailable', 409)
      if (item.kind === 'generation') {
        const model = resolveAgentModel('image', item.params.model)
        if (!model || model.model !== item.params.model || model.provider !== item.params.provider)
          throw new BatchPlanError('batch_execution_unavailable', 422)
      } else if (
        !isCapabilityEnabled('agent:batch-analysis') ||
        item.params.model !== config.agent.model
      )
        throw new BatchPlanError('batch_execution_unavailable', 422)
      targets = { ...targets, [key]: latest.attempt + 1 }
    }
    const targetAttempt = (key: string) => (Object.hasOwn(targets, key) ? targets[key]! : 1)
    const currentTargets = items.map((item) => {
      const attempt = attempts.find(
        (one) => one.item_key === item.key && one.attempt === targetAttempt(item.key),
      )
      return {
        key: item.key,
        submitted: Boolean(attempt),
        archived: Boolean(attempt?.terminal_snapshot),
        status:
          attempt?.terminal_snapshot?.errorCode === 'result_unknown'
            ? 'reconciling'
            : (attempt?.terminal_snapshot?.status ?? null),
      }
    })
    const sourceTargets = await readFrozenDependencyTargets(
      tx,
      id,
      plan.version,
      plan.confirmation?.sourceVersions ??
        (plan.confirmation?.sourceVersion ? [plan.confirmation.sourceVersion] : []),
      items,
    )
    const cancelled = cancelledBatchDependents(items, [...currentTargets, ...sourceTargets])
    // Reconfirmation pays only for targets that may still execute under the updated attempt map.
    const pending = items.filter(
      (item) =>
        !cancelled.has(item.key) &&
        !currentTargets.some((target) => target.key === item.key && target.submitted),
    )
    const pendingEstimate = await quoteBatchPlan(tx, userId, pending)
    if (
      pendingEstimate.analysis.status !== 'available' ||
      pendingEstimate.generation.status !== 'available'
    )
      throw new BatchPlanError('batch_price_changed', 409)
    const pendingKeys = new Set(pending.map((item) => item.key))
    const previousSnapshots = (kind: AgentBatchItem['kind']) => {
      const previous = plan.estimate_snapshot[kind]
      return previous.status === 'available'
        ? previous.snapshots.filter(
            (snapshot) => snapshot.itemKey && !pendingKeys.has(snapshot.itemKey),
          )
        : []
    }
    const estimate: AgentBatchEstimates = {
      analysis: {
        ...pendingEstimate.analysis,
        snapshots: [...previousSnapshots('analysis'), ...pendingEstimate.analysis.snapshots],
      },
      generation: {
        ...pendingEstimate.generation,
        snapshots: [...previousSnapshots('generation'), ...pendingEstimate.generation.snapshots],
      },
    }
    const confirmation = plan.confirmation
      ? { ...plan.confirmation, requiresResume: batch.status === 'paused' }
      : null
    const content = items
    const version = batch.current_version + 1
    const now = Date.now()
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          title: plan.title,
          rule: plan.rule,
          items: content,
          estimate,
          targets,
          retryItemKeys: keys,
          retryRequiresResume: batch.status === 'paused',
          confirmation,
        }),
      )
      .digest('hex')
    await tx.insert(schema.agent_batch_plans).values({
      batch_id: id,
      version,
      title: plan.title,
      rule: plan.rule,
      digest,
      item_count: plan.item_count,
      estimate_snapshot: estimate,
      attempt_targets: targets,
      retry_item_keys: keys,
      retry_requires_resume: batch.status === 'paused',
      confirmation,
      created_at: now,
    })
    await tx
      .insert(schema.agent_batch_items)
      .values(content.map((item) => ({ ...batchItemValues(item), batch_id: id, version })))
    await tx
      .update(schema.agent_batches)
      .set({
        status: 'paused',
        pause_reason: null,
        current_version: version,
        confirmed_version: null,
        dispatch_generation: batch.dispatch_generation + 1,
        updated_at: now,
      })
      .where(eq(schema.agent_batches.id, id))
    await tx.insert(schema.agent_batch_commands).values({
      batch_id: id,
      command_id: input.commandId,
      kind: 'retry_quote',
      request_hash: requestHash,
      created_at: now,
    })
  })
}

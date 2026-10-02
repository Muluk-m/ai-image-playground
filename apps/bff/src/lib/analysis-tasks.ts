import type { Context } from '@earendil-works/pi-ai'
import type {
  AgentBatchPriceSnapshot,
  AgentMediaReference,
  AnalysisFinding,
  AnalysisInputSnapshot,
} from '@image-playground/shared'
import { and, asc, eq, gt, inArray, isNull, lte } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'
import { heldBy } from '../db/task-transitions'
import { compactionSettings } from './agent/compaction-settings'
import { resolveOwnedMediaImages } from './agent/images'
import { assertRequestWithinBudget, requestInputTokens } from './agent/request-budget'
import { prepareVisualEvidence, visualEvidenceOf } from './agent/visual-input'
import { withVisualPreparation } from './agent/visual-resources'
import { analysisComparison } from './analysis-comparison'
import { isCapabilityEnabled } from './capabilities'
import { type ChatAttempt, extractJson } from './chatCompletion'
import {
  type BffTransaction,
  loadPrivateBffOverlay,
  type PrivateTaskHooks,
  type TaskReservationResult,
} from './private-overlay'
import { lockMediaOwner } from './projectMedia'
import { reservedTokenUsage, settledTokenUsage } from './token-pricing'
import { isObject } from './type-guards'

export const ANALYSIS_LEASE_MS = 60_000
export interface PreparedAnalysisTask extends AnalysisInputSnapshot {
  readonly images: readonly string[]
}

function analysisPrompt(
  prompt: string,
  inputs: readonly AgentMediaReference[],
  manifest = '',
  intent: AnalysisInputSnapshot['intent'] = 'inspection',
): string {
  return `${prompt}\n检查所有指定图片：${inputs.map((input) => input.imageId).join('、')}。只返回 JSON {"findings":[{"imageId":"指定图片编号","text":"针对该图片的结论"}]}，每张图片恰好一条；${intent === 'joint_comparison' ? '另外必须返回独立 comparison:{"status":"completed","imageIds":[全部指定图片编号],"text":"明确的图片间关系与比较结论"}。若无法完成联合比较，comparison.status 必须为 incomplete，不能用逐图描述冒充关系结论。' : ''}${manifest}`
}

export async function prepareAnalysisTask(input: {
  userId: string
  intent?: AnalysisInputSnapshot['intent']
  model: string
  prompt: string
  inputs: readonly AgentMediaReference[]
  maxOutputTokens?: number
  signal?: AbortSignal
}): Promise<PreparedAnalysisTask> {
  return withVisualPreparation(async () => {
    if (
      !input.inputs.length ||
      input.inputs.length > 100 ||
      new Set(input.inputs.map((one) => one.imageId)).size !== input.inputs.length
    )
      throw new Error('analysis_inputs_invalid')
    const images = await resolveOwnedMediaImages(input.inputs, input.userId)
    const visual = await prepareVisualEvidence(images, 'analysis')
    const prompt = analysisPrompt(input.prompt, input.inputs, visual.manifest, input.intent)
    const context: Context = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt }, ...visual.content],
          timestamp: 0,
        },
      ],
    }
    const maxOutputTokens = input.maxOutputTokens ?? config.agent.maxTokens
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1)
      throw new Error('analysis_output_budget_invalid')
    assertRequestWithinBudget(context, {
      ...compactionSettings({
        contextWindow: config.agent.contextWindow,
        maxTokens: maxOutputTokens,
      }),
      outputReserveTokens: maxOutputTokens,
    })
    return {
      model: input.model,
      intent: input.intent ?? 'inspection',
      prompt: input.prompt,
      inputs: input.inputs,
      estimatedInputTokens: requestInputTokens(context),
      visualManifest: visual.manifest,
      evidence: visual.content.map((block) => {
        const record = visualEvidenceOf(block)
        if (!record) throw new Error('analysis_visual_evidence_missing')
        return record
      }),
      images: visual.content.map((block) => `data:${block.mimeType};base64,${block.data}`),
    }
  }, input.signal)
}

export interface ReserveAnalysisTaskInput {
  tx: BffTransaction
  taskHooks: PrivateTaskHooks
  taskId: string
  userId: string
  deviceId: string
  batchId: string
  version: number
  itemKey: string
  attempt: number
  originConversationId: string | null
  originTurnId: string
  prepared: PreparedAnalysisTask
  pricing: AgentBatchPriceSnapshot
}

export async function quoteAnalysisTask(
  input: { tx: BffTransaction; userId: string; model: string; estimatedInputTokens: number },
  hooks?: PrivateTaskHooks,
) {
  if (!isCapabilityEnabled('billing:credits'))
    return {
      estimatedCredits: 0,
      pricing: {
        model: input.model,
        unit: 'kilo_token' as const,
        quantity: 1,
        unitMultiplier: 0,
        pricingVersion: `non-billing:${input.model}:${config.agent.maxTokens}`,
        quotedAt: Date.now(),
        validUntil: null,
        baseUnitCredits: 0,
        outputPriceRatio: 1,
        cachedInputPriceRatio: 0,
        inputEstimateTokens: input.estimatedInputTokens,
        outputReserveTokens: config.agent.maxTokens,
        exemption: 'non-billing' as const,
      },
    }
  return (hooks ?? (await loadPrivateBffOverlay()).taskHooks).quoteTokenTask?.(input) ?? null
}

export async function reserveAnalysisTask(
  input: ReserveAnalysisTaskInput,
): Promise<TaskReservationResult> {
  const { tx, taskHooks, prepared, pricing } = input
  if (
    pricing.model !== prepared.model ||
    pricing.inputEstimateTokens !== prepared.estimatedInputTokens ||
    pricing.unit !== 'kilo_token'
  )
    throw new Error('analysis_quote_changed')
  const current = await quoteAnalysisTask(
    {
      tx,
      userId: input.userId,
      model: prepared.model,
      estimatedInputTokens: prepared.estimatedInputTokens,
    },
    taskHooks,
  )
  if (!current || current.pricing.pricingVersion !== pricing.pricingVersion)
    throw new Error('analysis_quote_changed')
  await lockMediaOwner(tx, input.userId)
  const mediaIds = [
    ...new Set(
      prepared.inputs.flatMap((one) => [
        one.mediaId,
        ...(one.maskMediaId ? [one.maskMediaId] : []),
      ]),
    ),
  ]
  const media = await tx
    .select({ id: schema.media_objects.id })
    .from(schema.media_objects)
    .where(
      and(
        eq(schema.media_objects.user_id, input.userId),
        eq(schema.media_objects.status, 'ready'),
        inArray(schema.media_objects.id, mediaIds),
      ),
    )
  if (media.length !== mediaIds.length) throw new Error('analysis_inputs_unavailable')
  const now = Date.now()
  await tx.insert(schema.tasks).values({
    id: input.taskId,
    kind: 'analysis',
    provider: 'openai-compat',
    model: prepared.model,
    status: 'queued',
    reconciliation_required: true,
    request_payload: { prompt: '', device_id: input.deviceId },
    user_id: input.userId,
    agent_conversation_id: input.originConversationId,
    agent_turn_id: null,
    submitted_at: now,
  })
  const reserved =
    pricing.exemption === 'none'
      ? await taskHooks.reserveTask({
          tx,
          taskId: input.taskId,
          userId: input.userId,
          model: prepared.model,
          ...reservedTokenUsage(prepared.estimatedInputTokens, pricing),
        })
      : { kind: 'reserved' as const, credits: 0 }
  if (reserved.kind !== 'reserved') {
    await tx.delete(schema.tasks).where(eq(schema.tasks.id, input.taskId))
    return reserved
  }
  const { images: _images, ...snapshot } = prepared
  await tx.insert(schema.analysis_tasks).values({
    task_id: input.taskId,
    user_id: input.userId,
    device_id: input.deviceId,
    batch_id: input.batchId,
    plan_version: input.version,
    item_key: input.itemKey,
    attempt: input.attempt,
    origin_conversation_id: input.originConversationId,
    origin_turn_id: input.originTurnId,
    model: prepared.model,
    input_snapshot: snapshot,
    price_snapshot: pricing,
    reserved_credits: reserved.credits,
    status: 'queued',
    created_at: now,
  })
  await tx.insert(schema.analysis_model_calls).values({
    id: `${input.taskId}:call`,
    task_id: input.taskId,
    model: prepared.model,
    status: 'prepared',
    started_at: now,
  })
  await tx.insert(schema.media_references).values(
    mediaIds.map((mediaId) => ({
      user_id: input.userId,
      media_id: mediaId,
      owner_kind: 'analysis' as const,
      owner_id: input.taskId,
      created_at: now,
    })),
  )
  return reserved
}

export const analysisOwnership = (taskId: string, token: string) =>
  and(
    eq(schema.tasks.id, taskId),
    eq(schema.tasks.kind, 'analysis'),
    eq(schema.tasks.status, 'in_progress'),
    heldBy(token),
  )!

export async function claimAnalysisTask(taskId: string) {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.id, taskId),
          eq(schema.tasks.kind, 'analysis'),
          eq(schema.tasks.status, 'queued'),
        ),
      )
      .for('update')
    if (!task) return null
    const [analysis] = await tx
      .select()
      .from(schema.analysis_tasks)
      .where(eq(schema.analysis_tasks.task_id, taskId))
    const [call] = await tx
      .select()
      .from(schema.analysis_model_calls)
      .where(eq(schema.analysis_model_calls.task_id, taskId))
    if (!analysis || !call) throw new Error('analysis_record_missing')
    if (call.http_dispatch_count && (!call.usage || call.response_content === null))
      throw new Error('analysis_call_requires_reconciliation')
    const token = crypto.randomUUID()
    await tx
      .update(schema.tasks)
      .set({
        status: 'in_progress',
        execution_token: token,
        lease_expires_at: Date.now() + ANALYSIS_LEASE_MS,
        started_at: task.started_at ?? Date.now(),
      })
      .where(eq(schema.tasks.id, taskId))
    await tx
      .update(schema.analysis_tasks)
      .set({ status: 'in_progress' })
      .where(eq(schema.analysis_tasks.task_id, taskId))
    if (!call.http_dispatch_count)
      await tx
        .update(schema.analysis_model_calls)
        .set({ execution_token: token })
        .where(eq(schema.analysis_model_calls.id, call.id))
    return { token, analysis, call }
  })
}

export function analysisFindings(
  content: string | null,
  inputs: readonly AgentMediaReference[],
): AnalysisFinding[] | null {
  if (content === null) return null
  const parsed = extractJson(content)
  if (!isObject(parsed) || !Array.isArray(parsed.findings)) return null
  const ids = new Set(inputs.map((one) => one.imageId))
  const seen = new Set<string>()
  const findings: AnalysisFinding[] = []
  for (const one of parsed.findings) {
    if (
      !isObject(one) ||
      typeof one.imageId !== 'string' ||
      !ids.has(one.imageId) ||
      seen.has(one.imageId) ||
      typeof one.text !== 'string' ||
      !one.text.trim() ||
      one.text.length > 8000
    )
      return null
    seen.add(one.imageId)
    findings.push({ imageId: one.imageId, text: one.text })
  }
  return seen.size === ids.size ? findings : null
}

/** The analysis terminal transaction deliberately has no generation archive or chat-turn side effects. */
export async function finalizeAnalysisTask(
  taskId: string,
  token: string,
  options: { tx?: BffTransaction; confirmedNoResult?: boolean } = {},
): Promise<boolean> {
  const hooks = (await loadPrivateBffOverlay()).taskHooks
  const finish = async (tx: BffTransaction) => {
    const [task] = await tx
      .select()
      .from(schema.tasks)
      .where(analysisOwnership(taskId, token))
      .for('update')
    if (!task) return false
    const [analysis] = await tx
      .select()
      .from(schema.analysis_tasks)
      .where(eq(schema.analysis_tasks.task_id, taskId))
    const [call] = await tx
      .select()
      .from(schema.analysis_model_calls)
      .where(eq(schema.analysis_model_calls.task_id, taskId))
    if (!analysis || !call) throw new Error('analysis_record_missing')
    if (
      !options.confirmedNoResult &&
      call.http_dispatch_count &&
      (!call.usage || call.response_content === null)
    ) {
      await tx
        .update(schema.tasks)
        .set({
          status: 'reconciling',
          execution_token: null,
          lease_expires_at: null,
          error_type: 'upstream_result_unknown',
          error_message: '分析结果或用量待核查，预扣继续保留',
        })
        .where(eq(schema.tasks.id, taskId))
      await tx
        .update(schema.analysis_tasks)
        .set({ status: 'reconciling', error_code: 'upstream_result_unknown' })
        .where(eq(schema.analysis_tasks.task_id, taskId))
      return false
    }
    const response = call.response_content === null ? null : extractJson(call.response_content)
    const comparison =
      analysis.input_snapshot.intent === 'joint_comparison'
        ? analysisComparison(
            isObject(response) ? response.comparison : null,
            analysis.input_snapshot.inputs.map((one) => one.imageId),
          )
        : null
    const findings =
      options.confirmedNoResult ||
      (analysis.input_snapshot.intent === 'joint_comparison' && !comparison)
        ? null
        : analysisFindings(call.response_content, analysis.input_snapshot.inputs)
    const status = call.status === 'cancelled' ? 'cancelled' : findings ? 'completed' : 'failed'
    const completedAt = Date.now()
    const coverage = {
      ...(comparison ? { comparison } : {}),
      requiredImageIds: analysis.input_snapshot.inputs.map((one) => one.imageId),
      reviewedImageIds: findings?.map((one) => one.imageId) ?? [],
      missingImageIds: findings ? [] : analysis.input_snapshot.inputs.map((one) => one.imageId),
    }
    await tx
      .update(schema.tasks)
      .set({
        status,
        completed_at: completedAt,
        execution_token: null,
        lease_expires_at: null,
        result_payload: findings
          ? { findings, coverage, evidence: analysis.input_snapshot.evidence }
          : null,
        error_type: status === 'failed' ? 'upstream_error' : null,
        error_message: status === 'failed' ? '分析未取得覆盖完整输入的有效结论' : null,
      })
      .where(eq(schema.tasks.id, taskId))
    await tx
      .update(schema.analysis_tasks)
      .set({
        status,
        findings,
        coverage,
        evidence: findings ? analysis.input_snapshot.evidence : [],
        completed_at: completedAt,
        actual_credits: analysis.price_snapshot.exemption === 'none' ? null : 0,
        error_code:
          status === 'failed' ? (call.local_rejection ?? 'analysis_invalid_response') : null,
      })
      .where(eq(schema.analysis_tasks.task_id, taskId))
    if (analysis.price_snapshot.exemption === 'none')
      await hooks.finalizeTask({
        tx,
        taskId,
        outcome: status,
        upstreamInvocationCount: call.http_dispatch_count,
        actualUsage: settledTokenUsage(
          call.http_dispatch_count
            ? call.usage
            : (call.usage ?? { inputTokens: 0, outputTokens: 0 }),
          analysis.price_snapshot,
        ),
      })
    await tx
      .update(schema.analysis_model_calls)
      .set({ execution_token: null })
      .where(eq(schema.analysis_model_calls.id, call.id))
    return true
  }
  const finalized = options.tx ? await finish(options.tx) : await db.transaction(finish)
  if (finalized && !options.tx) await refreshAnalysisTaskCosts([taskId])
  return finalized
}

let analysisCostCursor: string | undefined
let analysisRecovery: Promise<void> | undefined

/** Billing is authoritative even after capability changes or transient task cleanup. Missing is not zero. */
export async function refreshAnalysisTaskCosts(taskIds?: readonly string[]): Promise<void> {
  if (taskIds && !taskIds.length) return
  const hooks = (await loadPrivateBffOverlay()).taskHooks
  let afterId = taskIds ? undefined : analysisCostCursor
  for (;;) {
    const pending = await db
      .select({ id: schema.analysis_tasks.task_id })
      .from(schema.analysis_tasks)
      .where(
        and(
          inArray(schema.analysis_tasks.status, ['completed', 'failed', 'cancelled']),
          isNull(schema.analysis_tasks.actual_credits),
          taskIds ? inArray(schema.analysis_tasks.task_id, [...taskIds]) : undefined,
          afterId === undefined ? undefined : gt(schema.analysis_tasks.task_id, afterId),
        ),
      )
      .orderBy(asc(schema.analysis_tasks.task_id))
      .limit(100)
    // Move before asynchronous settlement: a broken or missing old ledger entry cannot starve
    // later tasks. Wrapping on a later pass revisits unresolved entries without an unbounded scan.
    if (!taskIds)
      analysisCostCursor = pending.length === 100 ? pending[pending.length - 1]!.id : undefined
    if (!pending.length) return
    const credits = await hooks.taskCredits({ taskIds: pending.map((row) => row.id) })
    for (const { id } of pending) {
      const actual = credits[id]
      if (actual === undefined) continue
      await db
        .update(schema.analysis_tasks)
        .set({ actual_credits: actual })
        .where(
          and(eq(schema.analysis_tasks.task_id, id), isNull(schema.analysis_tasks.actual_credits)),
        )
    }
    if (!taskIds || pending.length < 100) return
    afterId = pending[pending.length - 1]!.id
  }
}

/** Persist the original executor's transport facts without granting it a new execution lease. */
export async function recordAnalysisAttempt(
  taskId: string,
  callId: string,
  token: string,
  attempt: ChatAttempt,
  cancelled: boolean,
): Promise<void> {
  const hooks = (await loadPrivateBffOverlay()).taskHooks
  await db.transaction(async (tx) => {
    // Match cancel/finalize lock order; late evidence does not regain a lease.
    const [task] = await tx
      .select({
        id: schema.tasks.id,
        status: schema.tasks.status,
        token: schema.tasks.execution_token,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .for('update')
    if (!task) return
    const recorded = await tx
      .update(schema.analysis_model_calls)
      .set({
        status:
          attempt.status === 'completed'
            ? 'completed'
            : attempt.httpDispatchCount
              ? 'unknown'
              : cancelled
                ? 'cancelled'
                : 'failed',
        http_dispatch_count: attempt.httpDispatchCount ?? 0,
        usage: attempt.usage,
        request_bytes: attempt.requestBytes,
        upstream_request_id: attempt.upstreamRequestId,
        local_rejection: attempt.localRejection?.reason,
        finished_at: attempt.finishedAt,
      })
      .where(
        and(
          eq(schema.analysis_model_calls.id, callId),
          eq(schema.analysis_model_calls.task_id, taskId),
          eq(schema.analysis_model_calls.execution_token, token),
          inArray(schema.analysis_model_calls.status, ['prepared', 'dispatched', 'unknown']),
        ),
      )
      .returning({ id: schema.analysis_model_calls.id })
    if (recorded.length)
      await tx
        .update(schema.tasks)
        .set({
          upstream_status: attempt.upstreamStatus ?? null,
          upstream_invocation_count: attempt.httpDispatchCount ?? 0,
        })
        .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.kind, 'analysis')))
    if (
      recorded.length &&
      attempt.httpDispatchCount === 0 &&
      task.status === 'reconciling' &&
      task.token === null
    ) {
      const [analysis] = await tx
        .select()
        .from(schema.analysis_tasks)
        .where(eq(schema.analysis_tasks.task_id, taskId))
      if (!analysis) throw new Error('analysis_record_missing')
      const completedAt = Date.now()
      await tx
        .update(schema.tasks)
        .set({
          status: 'cancelled',
          reconciliation_required: false,
          completed_at: completedAt,
          execution_token: null,
          lease_expires_at: null,
          error_type: null,
          error_message: null,
        })
        .where(eq(schema.tasks.id, taskId))
      await tx
        .update(schema.analysis_tasks)
        .set({
          status: 'cancelled',
          completed_at: completedAt,
          error_code: null,
          actual_credits: analysis.price_snapshot.exemption === 'none' ? null : 0,
        })
        .where(eq(schema.analysis_tasks.task_id, taskId))
      await tx
        .update(schema.analysis_model_calls)
        .set({
          status: 'cancelled',
          execution_token: null,
          usage: { inputTokens: 0, outputTokens: 0 },
        })
        .where(eq(schema.analysis_model_calls.id, callId))
      if (analysis.price_snapshot.exemption === 'none')
        await hooks.finalizeTask({
          tx,
          taskId,
          outcome: 'cancelled',
          upstreamInvocationCount: 0,
          actualUsage: settledTokenUsage(
            { inputTokens: 0, outputTokens: 0 },
            analysis.price_snapshot,
          ),
        })
    }
  })
}

/** A saved response can finish after restart; dispatch without a response is never retried. */
export function recoverAnalysisTasks(now = Date.now(), taskIds?: readonly string[]): Promise<void> {
  if (taskIds) return recoverAnalysisTaskPage(now, taskIds)
  if (analysisRecovery) return analysisRecovery
  analysisRecovery = recoverAnalysisTaskPage(now).finally(() => {
    analysisRecovery = undefined
  })
  return analysisRecovery
}

async function recoverAnalysisTaskPage(now: number, taskIds?: readonly string[]): Promise<void> {
  if (taskIds && !taskIds.length) return
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ taskId: schema.tasks.id })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.kind, 'analysis'),
          eq(schema.tasks.status, 'in_progress'),
          taskIds
            ? inArray(schema.tasks.id, [...taskIds])
            : lte(schema.tasks.lease_expires_at, now),
        ),
      )
      .for('update')
    for (const { taskId } of rows) {
      const [call] = await tx
        .select()
        .from(schema.analysis_model_calls)
        .where(eq(schema.analysis_model_calls.task_id, taskId))
      const status =
        !call?.http_dispatch_count || (call.usage && call.response_content !== null)
          ? ('queued' as const)
          : ('reconciling' as const)
      await tx
        .update(schema.tasks)
        .set({ status, execution_token: null, lease_expires_at: null })
        .where(eq(schema.tasks.id, taskId))
      await tx
        .update(schema.analysis_tasks)
        .set({ status })
        .where(eq(schema.analysis_tasks.task_id, taskId))
    }
  })
  await refreshAnalysisTaskCosts(taskIds)
}

export function analysisRequestPrompt(input: AnalysisInputSnapshot) {
  return analysisPrompt(input.prompt, input.inputs, input.visualManifest, input.intent)
}

/** Cancellation shares the dispatch row lock and never routes analysis through generation side effects. */
export async function cancelAnalysisTasks(
  access: import('drizzle-orm').SQL,
  executor?: BffTransaction,
): Promise<number> {
  const hooks = (await loadPrivateBffOverlay()).taskHooks
  const cancel = async (tx: BffTransaction) => {
    const rows = await tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(
        and(
          access,
          eq(schema.tasks.kind, 'analysis'),
          inArray(schema.tasks.status, ['queued', 'in_progress']),
        ),
      )
      .for('update')
    for (const { id } of rows) {
      const [analysis] = await tx
        .select()
        .from(schema.analysis_tasks)
        .where(eq(schema.analysis_tasks.task_id, id))
      const [call] = await tx
        .select()
        .from(schema.analysis_model_calls)
        .where(eq(schema.analysis_model_calls.task_id, id))
      if (!analysis || !call) throw new Error('analysis_record_missing')
      const status = call.http_dispatch_count ? ('reconciling' as const) : ('cancelled' as const)
      const completedAt = call.http_dispatch_count ? null : Date.now()
      await tx
        .update(schema.tasks)
        .set({
          status,
          completed_at: completedAt,
          execution_token: null,
          lease_expires_at: null,
          error_type: call.http_dispatch_count ? 'upstream_result_unknown' : null,
          error_message: call.http_dispatch_count
            ? '分析请求已派发，取消后仍需核查用量与结果'
            : null,
        })
        .where(eq(schema.tasks.id, id))
      await tx
        .update(schema.analysis_tasks)
        .set({
          status,
          completed_at: completedAt,
          error_code: call.http_dispatch_count ? 'upstream_result_unknown' : null,
          actual_credits: analysis.price_snapshot.exemption === 'none' ? null : 0,
        })
        .where(eq(schema.analysis_tasks.task_id, id))
      if (!call.http_dispatch_count) {
        const usage = { inputTokens: 0, outputTokens: 0 }
        await tx
          .update(schema.analysis_model_calls)
          .set({ status: 'cancelled', usage, execution_token: null, finished_at: completedAt })
          .where(eq(schema.analysis_model_calls.id, call.id))
        if (analysis.price_snapshot.exemption === 'none')
          await hooks.finalizeTask({
            tx,
            taskId: id,
            outcome: 'cancelled',
            upstreamInvocationCount: 0,
            actualUsage: settledTokenUsage(usage, analysis.price_snapshot),
          })
      }
    }
    return rows.length
  }
  return executor ? cancel(executor) : db.transaction(cancel)
}

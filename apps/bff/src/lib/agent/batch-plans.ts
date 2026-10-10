import { createHash } from 'node:crypto'
import type {
  AgentBatchEstimates,
  AgentBatchItem,
  AgentBatchItemExecution,
  AgentBatchItemProgress,
  AgentBatchPage,
  AgentBatchPriceSnapshot,
  AgentBatchUpdate,
  AgentBatchView,
  AgentMediaReference,
  AnalysisIntent,
} from '@image-playground/shared'
import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sql'
import { config } from '../../config'
import { db, schema } from '../../db/client'
import { quoteAnalysisTask } from '../analysis-tasks'
import { isCapabilityEnabled } from '../capabilities'
import { type BffTransaction, loadPrivateBffOverlay } from '../private-overlay'
import { queueTaskOutcome } from '../taskSubmission'
import { prepareBatchAnalysis } from './batch-analysis-preparation'
import { readBatchAnalysisSummary, readBatchSourceSummary } from './batch-analysis-summary'
import { cancelledBatchDependents, readFrozenDependencyTargets } from './batch-dependencies'
import { batchItem, batchItemValues } from './batch-items'
import { updatePendingBatchPhase } from './batch-phase-edit'
import { lockConversation } from './confirmations'
import { AgentToolError } from './tools/errors'
import { queueArtifacts, resolveAgentModel } from './tools/queueTask'
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
    readonly kind?: 'generation' | 'analysis'
    readonly intent?: AnalysisIntent
    readonly imageIds: readonly string[]
    readonly prompt: string
    readonly dependencies: readonly string[]
  }[]
}

function invalid(message: string): never {
  throw new AgentToolError('invalid_params', message)
}

/** Original and mask are one immutable selection and must retain both media objects. */
function batchMediaIds(items: readonly AgentBatchItem[]): string[] {
  return [
    ...new Set(
      items.flatMap((item) =>
        item.inputs.flatMap((reference) => [
          reference.mediaId,
          ...(reference.maskMediaId ? [reference.maskMediaId] : []),
        ]),
      ),
    ),
  ]
}

/** Reuse only an exact archived selection, never combine a known image with a new mask/action. */
export function sameArchivedReference(
  left: AgentMediaReference,
  right: AgentMediaReference,
): boolean {
  return (
    left.imageId === right.imageId &&
    left.mediaId === right.mediaId &&
    left.name === right.name &&
    left.maskMediaId === right.maskMediaId &&
    left.editAction === right.editAction &&
    (left.regions === undefined
      ? right.regions === undefined
      : right.regions !== undefined &&
        left.regions.length === right.regions.length &&
        left.regions.every((region, index) => {
          const other = right.regions![index]!
          return (
            region.x === other.x &&
            region.y === other.y &&
            region.width === other.width &&
            region.height === other.height
          )
        }))
  )
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
  const requestedIds = [
    ...new Set(
      input.items.flatMap((item) => item.imageIds.map((id) => context.images.identify(id))),
    ),
  ]
  const resolved = await context.images.resolveMediaReferences(requestedIds)
  const references = new Map(
    resolved.flatMap((reference) => (reference ? [[reference.imageId, reference] as const] : [])),
  )
  const keys = new Set<string>()
  const { autoSubmit: _autoSubmit, ...params } = context.params ?? {}
  const items: AgentBatchItem[] = []
  for (const [ordinal, item] of input.items.entries()) {
    if (!item.key.trim() || keys.has(item.key) || !item.prompt.trim())
      invalid('处理项编号不能重复，提示词不能为空。')
    if (item.dependencies.some((key) => !keys.has(key))) invalid('依赖必须指向前面的处理项。')
    keys.add(item.key)
    const inputs = item.imageIds.map((imageId): AgentMediaReference => {
      const identified = context.images.identify(imageId)
      const reference = references.get(identified)
      if (!reference || !('mediaId' in reference))
        invalid(
          `图片 ${imageId} 当前没有可用的已保存原图。请用 readConversationImages 核对会话图片及可用状态；新上传的图片请等待保存完成。`,
        )
      return { ...reference, imageId: identified }
    })
    const common = {
      key: item.key,
      ordinal,
      inputs,
      prompt: item.prompt,
      dependencies: item.dependencies,
    }
    if (item.kind === 'analysis') {
      if (!isCapabilityEnabled('agent:batch-analysis') || !config.agent.model)
        invalid('图片分析暂未开放。')
      const prepared = await prepareBatchAnalysis({
        userId,
        model: config.agent.model,
        prompt: item.prompt,
        inputs,
        intent: item.intent,
      })
      items.push({
        ...common,
        kind: 'analysis',
        params: {
          model: prepared.model,
          intent: prepared.intent,
          estimatedInputTokens: prepared.estimatedInputTokens,
          evidence: prepared.evidence,
        },
      })
    } else {
      const target = resolveAgentModel('image', context.params?.model)
      if (!target) throw new AgentToolError('model_unavailable', '暂时没有可用的生图模型')
      items.push({ ...common, kind: 'generation', params: { ...params, ...target } })
    }
  }
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
    const mediaIds = batchMediaIds(items)
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
      .values(items.map((item) => ({ batch_id: id, version: 1, ...batchItemValues(item) })))
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
      | AgentToolError['code']
      | 'context_overflow'
      | 'analysis_inputs_invalid'
      | 'analysis_output_budget_invalid'
      | 'analysis_visual_evidence_missing'
      | 'batch_execution_unavailable'
      | 'batch_retry_unavailable'
      | 'batch_analysis_incomplete'
      | 'batch_scope_reduction_required'
      | 'batch_size_exceeded'
      | 'batch_source_limit_exceeded'
      | 'batch_source_version_conflict'
      | 'batch_price_changed'
      | 'batch_submission_refused'
      | 'batch_input_limit'
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
  // Keep page state and both summaries on one snapshot without borrowing another connection.
  const page: AgentBatchPage | null = await db.$client.begin(
    'isolation level repeatable read read only',
    async (client) => {
      const tx = drizzle(client, { schema })
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
      const [row] = await tx
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
      const items = await tx
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
      const pageKeys = items.slice(0, limit).map((item) => item.key)
      const attemptScope = and(
        eq(schema.agent_batch_attempts.batch_id, id),
        lte(schema.agent_batch_attempts.version, plan.version),
      )
      const effectiveStatus = sql<
        AgentBatchItemExecution['status']
      >`CASE WHEN ${schema.agent_batch_attempts.terminal_snapshot}->>'errorCode' = 'result_unknown' THEN 'reconciling' ELSE coalesce(${schema.agent_batch_attempts.terminal_snapshot}->>'status', ${schema.tasks.status}, 'reconciling') END`
      const [totals] = await tx
        .select({
          submittedCount: sql<number>`count(*)`.mapWith(Number),
          allTerminal: sql<boolean>`coalesce(bool_and(${effectiveStatus} IN ('completed', 'failed', 'cancelled')), true)`,
        })
        .from(schema.agent_batch_attempts)
        .leftJoin(schema.tasks, eq(schema.tasks.id, schema.agent_batch_attempts.task_id))
        .where(attemptScope)
      // Dependencies may be on another page. Only the current plan's <=100 approved targets
      // need status/error scalars; older result bodies do not enter this working set.
      const targetRows = await tx
        .select({
          key: schema.agent_batch_items.key,
          archived: sql<boolean>`${schema.agent_batch_attempts.terminal_snapshot} IS NOT NULL`,
          status: effectiveStatus,
          errorCode: sql<
            string | null
          >`${schema.agent_batch_attempts.terminal_snapshot}->>'errorCode'`,
        })
        .from(schema.agent_batch_items)
        .innerJoin(
          schema.agent_batch_plans,
          and(
            eq(schema.agent_batch_plans.batch_id, schema.agent_batch_items.batch_id),
            eq(schema.agent_batch_plans.version, schema.agent_batch_items.version),
          ),
        )
        .innerJoin(
          schema.agent_batch_attempts,
          and(
            eq(schema.agent_batch_attempts.batch_id, schema.agent_batch_items.batch_id),
            eq(schema.agent_batch_attempts.item_key, schema.agent_batch_items.key),
            lte(schema.agent_batch_attempts.version, plan.version),
            sql`${schema.agent_batch_attempts.attempt} = coalesce((${schema.agent_batch_plans.attempt_targets} ->> ${schema.agent_batch_items.key})::integer, 1)`,
          ),
        )
        .leftJoin(schema.tasks, eq(schema.tasks.id, schema.agent_batch_attempts.task_id))
        .where(
          and(
            eq(schema.agent_batch_items.batch_id, id),
            eq(schema.agent_batch_items.version, plan.version),
          ),
        )
        .limit(100)
      const targets = new Map(targetRows.map((one) => [one.key, one]))
      const sourceVersions =
        plan.confirmation?.sourceVersions ??
        (plan.confirmation?.sourceVersion ? [plan.confirmation.sourceVersion] : [])
      const dependencyItems = await tx
        .select({
          key: schema.agent_batch_items.key,
          dependencies: schema.agent_batch_items.dependencies,
        })
        .from(schema.agent_batch_items)
        .where(
          and(
            eq(schema.agent_batch_items.batch_id, id),
            eq(schema.agent_batch_items.version, plan.version),
          ),
        )
        .limit(100)
      const sourceTargets = await readFrozenDependencyTargets(
        tx,
        id,
        plan.version,
        sourceVersions,
        dependencyItems,
      )
      for (const source of sourceTargets) {
        if (source.taskId) targets.set(source.key, source)
      }
      const attemptRows = await tx
        .select({
          itemKey: schema.agent_batch_attempts.item_key,
          attempt: schema.agent_batch_attempts.attempt,
          taskId: schema.agent_batch_attempts.task_id,
          status: schema.tasks.status,
          provider: schema.tasks.provider,
          resultPayload: schema.tasks.result_payload,
          errorMessage: schema.tasks.error_message,
          errorType: schema.tasks.error_type,
          snapshot: schema.agent_batch_attempts.terminal_snapshot,
        })
        .from(schema.agent_batch_attempts)
        .leftJoin(schema.tasks, eq(schema.tasks.id, schema.agent_batch_attempts.task_id))
        .where(and(attemptScope, inArray(schema.agent_batch_attempts.item_key, pageKeys)))
      attemptRows.sort((a, b) => a.attempt - b.attempt)
      const attempts = attemptRows.map((one) => ({
        ...one,
        status:
          one.snapshot?.errorCode === 'result_unknown'
            ? ('reconciling' as const)
            : (one.snapshot?.status ?? one.status ?? ('reconciling' as const)),
      }))
      const terminal = attempts.filter((one) =>
        ['completed', 'failed', 'cancelled'].includes(one.status),
      )
      const pageTaskIds = new Set(attempts.map((one) => one.taskId))
      const credits: Record<string, number> = Object.fromEntries(
        terminal.flatMap((one) =>
          one.snapshot?.actualCredits != null ? [[one.taskId, one.snapshot.actualCredits]] : [],
        ),
      )
      const analysisResults = new Map(
        (
          await tx
            .select({
              task_id: schema.analysis_tasks.task_id,
              actual_credits: schema.analysis_tasks.actual_credits,
              findings: schema.analysis_tasks.findings,
              coverage: schema.analysis_tasks.coverage,
              evidence: schema.analysis_tasks.evidence,
            })
            .from(schema.analysis_tasks)
            .where(
              and(
                eq(schema.analysis_tasks.batch_id, id),
                inArray(schema.analysis_tasks.task_id, [...pageTaskIds]),
              ),
            )
        ).map((one) => [one.task_id, one]),
      )
      const history = new Map<string, AgentBatchItemExecution[]>()
      for (const one of attempts) {
        const live =
          !one.snapshot && one.provider
            ? queueTaskOutcome({
                status: one.status,
                provider: one.provider,
                result_payload: one.resultPayload,
                error_message: one.errorMessage,
                error_type: one.errorType,
              })
            : null
        const analysis = analysisResults.get(one.taskId)
        const entry: AgentBatchItemExecution = {
          taskId: one.taskId,
          status: one.status,
          attempt: one.attempt,
          actualCredits: analysis
            ? analysis.actual_credits
            : terminal.includes(one)
              ? (credits[one.taskId] ?? null)
              : null,
          ...(analysis
            ? {
                artifacts: [],
                analysis: {
                  findings: analysis.findings,
                  coverage: analysis.coverage,
                  evidence: analysis.evidence,
                },
              }
            : {}),
          ...(one.snapshot
            ? {
                artifacts: one.snapshot.artifacts,
                errorCode: one.snapshot.errorCode,
                message: one.snapshot.message,
                ...(one.snapshot.analysis ? { analysis: one.snapshot.analysis } : {}),
              }
            : live?.kind === 'completed'
              ? { artifacts: queueArtifacts(one.taskId, 'image', live.result) }
              : {}),
        }
        history.set(one.itemKey, [...(history.get(one.itemKey) ?? []), entry])
      }
      const execution = new Map(
        [...history].map(([key, entries]) => [key, entries[entries.length - 1]!]),
      )
      const cancelled = cancelledBatchDependents(dependencyItems, [
        ...targetRows.map((target) => ({ ...target, submitted: true })),
        ...sourceTargets,
      ])
      const complete =
        batch.confirmed_version === plan.version &&
        targetRows.filter((one) => ['completed', 'failed', 'cancelled'].includes(one.status))
          .length +
          cancelled.size ===
          plan.item_count &&
        Boolean(totals?.allTerminal)
      const targetExecution = (key: string) => targets.get(key)
      const progressOf = (
        item: AgentBatchItem,
      ): { progress: AgentBatchItemProgress; blockedBy?: string[] } => {
        if (cancelled.has(item.key))
          return {
            progress: 'cancelled',
            blockedBy: item.dependencies.filter(
              (key) => cancelled.has(key) || targetExecution(key)?.status === 'cancelled',
            ),
          }
        const current = targetExecution(item.key)
        if (current) {
          if (current.status === 'queued' || current.status === 'in_progress')
            return { progress: 'in_flight' }
          if (current.status === 'failed' && current.errorCode === 'result_unknown')
            return { progress: 'reconciling' }
          return { progress: current.status }
        }
        const blockedBy = item.dependencies.filter((key) => {
          const dependency = targetExecution(key)
          return dependency && ['failed', 'cancelled', 'reconciling'].includes(dependency.status)
        })
        if (blockedBy.length) return { progress: 'blocked', blockedBy }
        if (batch.status === 'cancelled') return { progress: 'cancelled' }
        const ready =
          batch.status === 'running' &&
          batch.confirmed_version === plan.version &&
          item.dependencies.every((key) => targetExecution(key)?.status === 'completed')
        return { progress: ready ? 'ready' : 'pending' }
      }
      const analysisSummary = await readBatchAnalysisSummary(id, plan.version, undefined, tx)
      const sourceAnalysisSummary = sourceVersions.length
        ? await readBatchSourceSummary(id, sourceVersions, tx)
        : undefined
      return {
        ...(analysisSummary ? { analysisSummary } : {}),
        ...(sourceAnalysisSummary ? { sourceAnalysisSummary } : {}),
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
          ...(plan.confirmation ? { confirmation: plan.confirmation } : {}),
          ...(plan.retry_item_keys.length
            ? {
                retryItemKeys: plan.retry_item_keys,
                retryRequiresResume: plan.retry_requires_resume,
              }
            : {}),
          submittedCount: totals?.submittedCount ?? 0,
          actualCredits: 0,
          estimate: plan.estimate_snapshot,
          createdAt: batch.created_at,
        } satisfies AgentBatchView,
        items: items.slice(0, limit).map(({ batch_id: _batch, version: _version, ...item }) => ({
          ...batchItem(item),
          ...progressOf(batchItem(item)),
          ...(execution.has(item.key)
            ? { execution: execution.get(item.key)!, attempts: history.get(item.key)! }
            : {}),
        })),
        nextCursor:
          items.length > limit
            ? Buffer.from(JSON.stringify([id, plan.version, items[limit - 1]!.ordinal])).toString(
                'base64url',
              )
            : null,
      }
    },
  )
  if (!page) return null
  // Settled costs may be newer than the page-state snapshot. Freeze each row's archive-or-hook
  // choice once, after releasing the transaction, so concurrent archival cannot skip or double count it.
  const pageTaskIds = new Set(
    page.items.flatMap((item) => (item.attempts ?? []).map((one) => one.taskId)),
  )
  const pageCredits = new Map<string, number>()
  let actualCredits = 0
  let afterTaskId: string | undefined
  const taskHooks = (await loadPrivateBffOverlay()).taskHooks
  for (;;) {
    const rows = await db
      .select({
        taskId: schema.agent_batch_attempts.task_id,
        status: sql<string>`CASE WHEN ${schema.agent_batch_attempts.terminal_snapshot}->>'errorCode' = 'result_unknown' THEN 'reconciling' ELSE coalesce(${schema.agent_batch_attempts.terminal_snapshot}->>'status', ${schema.tasks.status}, 'reconciling') END`,
        archivedCredits: sql<
          number | null
        >`(${schema.agent_batch_attempts.terminal_snapshot}->>'actualCredits')::double precision`,
      })
      .from(schema.agent_batch_attempts)
      .leftJoin(schema.tasks, eq(schema.tasks.id, schema.agent_batch_attempts.task_id))
      .where(
        and(
          eq(schema.agent_batch_attempts.batch_id, id),
          lte(schema.agent_batch_attempts.version, page.batch.version),
          afterTaskId === undefined
            ? undefined
            : gt(schema.agent_batch_attempts.task_id, afterTaskId),
        ),
      )
      .orderBy(asc(schema.agent_batch_attempts.task_id))
      .limit(100)
    if (!rows.length) break
    const terminal = rows.filter((one) => ['completed', 'failed', 'cancelled'].includes(one.status))
    const legacyIds = terminal
      .filter((one) => one.archivedCredits === null)
      .map((one) => one.taskId)
    const liveCredits: Readonly<Record<string, number>> = legacyIds.length
      ? await taskHooks.taskCredits({ taskIds: legacyIds })
      : {}
    for (const one of terminal) {
      const value = one.archivedCredits ?? liveCredits[one.taskId]
      if (value !== undefined) {
        actualCredits += value
        if (pageTaskIds.has(one.taskId)) pageCredits.set(one.taskId, value)
      }
    }
    if (rows.length < 100) break
    afterTaskId = rows[rows.length - 1]!.taskId
  }
  const withCredits = (entry: AgentBatchItemExecution): AgentBatchItemExecution => {
    const value = pageCredits.get(entry.taskId)
    return value === undefined || entry.analysis ? entry : { ...entry, actualCredits: value }
  }
  return {
    ...page,
    batch: { ...page.batch, actualCredits },
    items: page.items.map((item) => ({
      ...item,
      ...(item.execution ? { execution: withCredits(item.execution) } : {}),
      ...(item.attempts ? { attempts: item.attempts.map(withCredits) } : {}),
    })),
  }
}

export async function updateAgentBatchPlan(
  userId: string,
  id: string,
  input: AgentBatchUpdate,
): Promise<void> {
  if (await updatePendingBatchPhase(userId, id, input)) return
  const preparedAnalysis = new Map<
    string,
    Omit<Awaited<ReturnType<typeof prepareBatchAnalysis>>, 'images'>
  >()
  for (const item of input.items) {
    if (item.kind !== 'analysis') continue
    if (!isCapabilityEnabled('agent:batch-analysis') || item.params.model !== config.agent.model)
      throw new BatchPlanError('batch_execution_unavailable', 422)
    const { images: _images, ...snapshot } = await prepareBatchAnalysis({
      userId,
      model: item.params.model,
      prompt: item.prompt,
      inputs: item.inputs,
      intent: item.params.intent,
    })
    preparedAnalysis.set(item.key, snapshot)
  }
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
    const currentItems = await tx
      .select({
        key: schema.agent_batch_items.key,
        inputs: schema.agent_batch_items.inputs,
        params: schema.agent_batch_items.params,
      })
      .from(schema.agent_batch_items)
      .where(
        and(
          eq(schema.agent_batch_items.batch_id, id),
          eq(schema.agent_batch_items.version, batch.current_version),
        ),
      )
    const references = messages
      .flatMap((message) =>
        message.content.flatMap((block) => (block.type === 'text' ? (block.references ?? []) : [])),
      )
      .filter((reference): reference is AgentMediaReference => 'mediaId' in reference)
      .concat(currentItems.flatMap((item) => item.inputs))
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
      const inputs = item.inputs.map((reference) => {
        const stored = references.find((one) => sameArchivedReference(one, reference))
        if (!stored) throw new BatchPlanError('invalid_batch_plan', 422)
        return stored
      })
      if (item.kind === 'analysis') {
        const prepared = preparedAnalysis.get(item.key)
        if (!prepared) throw new BatchPlanError('invalid_batch_plan', 422)
        const previousParams = currentItems.find((previous) => previous.key === item.key)?.params
        const intent =
          item.params.intent ??
          (previousParams && 'estimatedInputTokens' in previousParams
            ? previousParams.intent
            : undefined) ??
          'inspection'
        return {
          key: item.key,
          ordinal,
          kind: 'analysis',
          inputs,
          prompt: item.prompt,
          dependencies: item.dependencies,
          params: {
            model: prepared.model,
            intent,
            estimatedInputTokens: prepared.estimatedInputTokens,
            evidence: prepared.evidence,
          },
        }
      }
      const target = resolveAgentModel('image', item.params.model)
      if (!target || target.model !== item.params.model || target.provider !== item.params.provider)
        throw new BatchPlanError('invalid_batch_plan', 422)
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
    const mediaIds = batchMediaIds(items)
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
      .values(items.map((item) => ({ ...batchItemValues(item), batch_id: id, version })))
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

export async function quoteBatchPlan(
  tx: BffTransaction,
  userId: string,
  items: readonly AgentBatchItem[],
): Promise<AgentBatchEstimates> {
  const hooks = (await loadPrivateBffOverlay()).taskHooks
  const generationQuotes = new Map<
    string,
    Awaited<ReturnType<NonNullable<typeof hooks.quoteTask>>> | undefined
  >()
  const generationQuote = async (model: string) => {
    if (!generationQuotes.has(model))
      generationQuotes.set(
        model,
        await hooks.quoteTask?.({ tx, userId, model, quantity: 1, unitMultiplier: 1 }),
      )
    return generationQuotes.get(model)
  }
  const quoteKind = async (kind: AgentBatchItem['kind']) => {
    const selected = items.filter((item) => item.kind === kind)
    if (!selected.length) return emptyEstimate
    const snapshots: AgentBatchPriceSnapshot[] = []
    let estimatedCredits = 0
    let estimatedChargeCredits = 0
    for (const item of selected) {
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
          : await generationQuote(item.params.model)
      if (!quote) return { status: 'unavailable' as const, reason: 'price_unavailable' as const }
      estimatedCredits += quote.estimatedCredits
      estimatedChargeCredits += quote.pricing.exemption === 'none' ? quote.estimatedCredits : 0
      snapshots.push({ ...quote.pricing, itemKey: item.key })
    }
    return { status: 'available' as const, estimatedCredits, estimatedChargeCredits, snapshots }
  }
  return { analysis: await quoteKind('analysis'), generation: await quoteKind('generation') }
}

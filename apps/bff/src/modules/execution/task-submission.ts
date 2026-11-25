import { isBlankPrompt, isGptImage26Model } from '@image-playground/shared'
import { trace } from '@opentelemetry/api'
import { sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { publishGenerations } from '../../db/generation-events'
import { isCapabilityEnabled } from '../../lib/capabilities'
import { currentTraceparent } from '../../lib/telemetry'
import { gptImage26Enabled } from '../../lib/upstream/gpt-direct-availability'
import {
  checkSubmissionAccessGates,
  loadSubmissionTaskHooks,
  MaxCreditsExceeded,
  readDailyQuotaConfig,
  reserveSubmissionBillingOrQuota,
  resolveSubmissionMetering,
} from './submission-admission'
import {
  adoptLegacyCommand,
  commandHash,
  dedupesRecentSubmission,
  findRecentDuplicate,
  legacyCommandHashes,
  lookupRecentDuplicate,
  replayCommand,
} from './submission-idempotency'
import {
  discardArchivedInputs,
  type PreparedQueueTask,
  prepareAlignedQueueTask,
  prepareQueueTask,
} from './submission-prepare'
import {
  alignImageTier,
  alignStageSubmission,
  degradeImage26Alignment,
  GPT_IMAGE_26_REJECTION_MESSAGE,
  gptImage26RequestProblem,
  type ImageTierAlignment,
  pricingOf,
  strictImage26Refusal,
} from './submission-tier'
import type { ExecutionTransaction } from './task-lifecycle-bus'
import { insertTaskPayload } from './task-payloads'
import {
  assertTaskSubmissionPluginRegistered,
  type CreateQueueTaskInput,
  type CreateQueueTaskOutcome,
  runSubmissionAfterTaskCreated,
  runSubmissionBeforeAdmission,
  type SubmitPreparedResult,
} from './task-submission-plugins'

/**
 * 先归档全部输入，再开一个事务交给 `work`；`work` 用 `submit(index)` 在这个事务里提交第 index 条。
 * 归档要读对象存储，放在事务外，握着锁和连接时不去等它。
 *
 * 归档的清理归这里：事务回滚（`work` 抛错）时全部丢弃；事务提交后，没建成任务的那几条
 * （被拒、命中幂等回执、`work` 没提交它）丢弃。任何一条准备失败时丢弃已准备的，返回 `refused`。
 * `submit` 抛过错时事务一律回滚：`work` 吞掉了异常，这里也会在事务内重新抛出。
 */
export async function submitPrepared<T>(
  inputs: readonly CreateQueueTaskInput[],
  work: (
    tx: ExecutionTransaction,
    submit: (index: number) => Promise<CreateQueueTaskOutcome>,
  ) => Promise<T>,
): Promise<SubmitPreparedResult<T>> {
  const prepared: PreparedQueueTask[] = []
  const discardExcept = (kept: ReadonlySet<string>) =>
    Promise.all(
      prepared
        .filter((one) => !kept.has(one.taskId))
        .map((one) => discardArchivedInputs(one.taskId)),
    )
  try {
    for (const [index, input] of inputs.entries()) {
      const preparation = await prepareQueueTask(input)
      if (preparation.kind !== 'prepared') {
        await discardExcept(new Set())
        return { kind: 'refused', index, outcome: preparation }
      }
      prepared.push(preparation.prepared)
    }
  } catch (error) {
    await discardExcept(new Set())
    throw error
  }
  const created = new Set<string>()
  // `submit` 抛过错而 `work` 吞掉了它：仍让整个事务回滚。提交了半截（例如预扣后才抛错）的任务
  // 不能落库，否则调用方以为失败去重试，会多建一条、多扣一次。
  let submitError: unknown
  let value: T
  try {
    value = await db.transaction(async (tx) => {
      const result = await work(tx, async (index) => {
        const one = prepared[index]
        if (!one) throw new RangeError(`no prepared submission at ${index}`)
        try {
          const outcome = await submitQueueTask({ ...inputs[index]!, tx }, one)
          if (outcome.kind === 'created' && outcome.taskId === one.taskId) created.add(one.taskId)
          return outcome
        } catch (error) {
          submitError ??= error
          throw error
        }
      })
      if (submitError !== undefined) throw submitError
      return result
    })
  } catch (error) {
    await discardExcept(new Set())
    throw error
  }
  await discardExcept(created)
  return { kind: 'committed', value }
}

export async function createQueueTask(raw: CreateQueueTaskInput): Promise<CreateQueueTaskOutcome> {
  return submitQueueTask(raw)
}

function assertRequiredSubmissionPlugins(input: CreateQueueTaskInput): void {
  if (input.stageAuthorization) assertTaskSubmissionPluginRegistered('stage-authorization')
  if (input.agent?.job) assertTaskSubmissionPluginRegistered('agent-job')
  if (input.userId && input.agent && !input.video && isCapabilityEnabled('accounts:sync')) {
    assertTaskSubmissionPluginRegistered('project-archive')
  }
}

/**
 * 四步核心提交管道：
 * 1. 校验与档位对齐（`alignStageSubmission` / `alignImageTier` / `gptImage26` 规则）；
 * 2. 幂等重放与输入归档（`replayCommand` / `prepareAlignedQueueTask`）；
 * 3. 事务内准入与计费/配额预扣（`checkSubmissionAdmission` / `reserveSubmissionBillingOrQuota`）；
 * 4. 触发 `afterTaskCreated` 扩展插件、写入幂等回执并发布生成记录。
 */
async function submitQueueTask(
  raw: CreateQueueTaskInput,
  prepared?: PreparedQueueTask,
): Promise<CreateQueueTaskOutcome> {
  const stage = alignStageSubmission(raw)
  // 产品开关是唯一来源。关着时连 1K 也不降级、不送 sub2api。
  if (isGptImage26Model(stage.model) && !stage.video && !gptImage26Enabled())
    return { kind: 'model_unavailable', message: GPT_IMAGE_26_REJECTION_MESSAGE.unavailable }
  // 预先准备的沿用冻结的请求与视频参数（带授权的视频时长在准备时已收口），只换上这次的事务。
  // 幂等身份是降级前的请求：直连后来不可用或恢复，同一条命令仍是这一单。
  const identityAligned = prepared ? null : await alignImageTier(stage)
  if (identityAligned) {
    const strictRefusal = await strictImage26Refusal(identityAligned.input)
    if (strictRefusal) return strictRefusal
  }
  const aligned: ImageTierAlignment = prepared
    ? { ...prepared.alignment, input: { ...prepared.alignment.input, tx: raw.tx } }
    : await degradeImage26Alignment(identityAligned!)
  const input = aligned.input
  if (
    input.maxCredits !== undefined &&
    (!Number.isFinite(input.maxCredits) || input.maxCredits < 0)
  )
    throw new TypeError('maxCredits must be a finite, non-negative number')
  // 只有空白、控制符或零宽字符的提示词和空的一样：所有入口都不建任务，也就不预扣积分。
  if (isBlankPrompt(input.request.prompt)) return { kind: 'invalid_prompt' }
  const image26 = gptImage26RequestProblem(input)
  if (image26) return image26
  if (input.reconciliationRequired && input.video)
    throw new TypeError('reconciliation_requires_image_task')
  assertRequiredSubmissionPlugins(input)
  const commandId = input.request.client_request_id
  // 预先准备的哈希在准备时就按降级前的请求钉死。提交时不能按现在的会员身份重算，
  // 否则会员中途变化会把同一条准备好的提交判成另一个请求。
  const hash = prepared ? prepared.requestHash : commandHash(identityAligned!.input)
  const legacyHashes = prepared ? [] : legacyCommandHashes(identityAligned!.input)
  // 外部事务在场时不走历史命令认领：它自己要开一个事务，握着连接的调用方会因此卡在连接池上。
  // 确认生成用的是新建的命令 id，没有历史任务可认领。
  if (input.userId && commandId) {
    const replay = await replayCommand(input.tx ?? db, input.userId, commandId, hash, legacyHashes)
    if (replay) return replay
    if (!input.tx) {
      const legacy = await adoptLegacyCommand(input.userId, commandId, hash, legacyHashes)
      if (legacy) return legacy
    }
  }
  // 内容指纹按归档前的请求算。先查近期重复，命中就不必再把参考图写进对象存储。
  // 并发连点仍靠事务里带锁的那次检查兜住；这里只挡「上一单已经落库」的再提交。
  if (!prepared && dedupesRecentSubmission(input)) {
    const duplicate = await lookupRecentDuplicate(input.tx ?? db, input.userId, hash)
    if (duplicate) return { kind: 'duplicate_submission' as const, taskId: duplicate.taskId }
  }
  const preparation = prepared
    ? { kind: 'prepared' as const, prepared }
    : await prepareAlignedQueueTask(aligned, identityAligned!.input)
  if (preparation.kind !== 'prepared') return preparation
  const { taskId: id, requestPayload, requestHash } = preparation.prepared
  // 同一份冻结的对齐结果算出来的，不相等只能是 module 内部的 bug。
  if (requestHash !== hash) throw new TypeError('prepared_queue_request_mismatch')

  const now = Date.now()
  const pricing = pricingOf(input, aligned.decision)
  const taskHooks = await loadSubmissionTaskHooks()
  const { dailyQuotaEnabled, dailyImageQuota } = readDailyQuotaConfig()
  const submit = async (tx: ExecutionTransaction): Promise<CreateQueueTaskOutcome> => {
    await runSubmissionBeforeAdmission(tx, input)
    if (input.userId && commandId) {
      // A per-command transaction lock also covers the first submission, before a receipt exists.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['generation-command', input.userId, commandId])}, 0))`,
      )
      const replay = await replayCommand(tx, input.userId, commandId, hash, legacyHashes)
      if (replay) return replay
    }
    const gateRefusal = await checkSubmissionAccessGates(tx, input, aligned)
    if (gateRefusal) return gateRefusal
    if (dedupesRecentSubmission(input)) {
      const duplicate = await findRecentDuplicate(tx, input.userId, hash)
      if (duplicate) return { kind: 'duplicate_submission' as const, taskId: duplicate.taskId }
    }
    const admission = await resolveSubmissionMetering(tx, input, aligned, pricing, taskHooks)
    if (admission.kind === 'refused') return admission.outcome
    const { metering, unmeteredByDecision } = admission

    const inserted = await tx
      .insert(schema.tasks)
      .values({
        id,
        provider: input.provider,
        model: input.model,
        status: 'queued',
        reconciliation_required: input.reconciliationRequired ?? false,
        submitted_at: now,
        user_id: input.userId,
        device_id: requestPayload.device_id ?? null,
        client_request_id: input.request.client_request_id ?? null,
        agent_conversation_id: input.agent?.conversationId ?? null,
        agent_turn_id: input.agent?.turnId ?? null,
        traceparent: currentTraceparent(),
      })
      .onConflictDoNothing()
      .returning({ id: schema.tasks.id, submitted_at: schema.tasks.submitted_at })

    if (inserted.length === 0) return { kind: 'idempotency_conflict' as const }
    await insertTaskPayload(tx, {
      task_id: id,
      request_payload: requestPayload,
      metering,
    })
    // 提交链路上记下任务 ID：从任务反查提交 trace、从提交 trace 找到任务，两个方向都能查。
    trace.getActiveSpan()?.setAttribute('task.id', id)

    const reservation = await reserveSubmissionBillingOrQuota(tx, {
      taskId: id,
      input,
      pricing,
      metering,
      unmeteredByDecision,
      taskHooks,
      dailyQuotaEnabled,
      dailyImageQuota,
    })
    if (reservation.kind === 'refused') return reservation.outcome

    await runSubmissionAfterTaskCreated(tx, {
      input,
      taskId: id,
      submittedAt: now,
      requestPayload,
      pricing,
      reservedCredits: reservation.reservedCredits,
    })
    if (input.userId && commandId)
      await tx.insert(schema.generation_commands).values({
        user_id: input.userId,
        command_id: commandId,
        request_hash: hash,
        task_id: id,
        submitted_at: now,
      })
    await publishGenerations(tx, [id])
    return {
      kind: 'created' as const,
      taskId: inserted[0]!.id,
      submittedAt: inserted[0]!.submitted_at,
    }
  }
  let outcome: CreateQueueTaskOutcome
  try {
    outcome = input.tx ? await submit(input.tx) : await db.transaction(submit)
  } catch (error) {
    if (!prepared) await discardArchivedInputs(id)
    if (error instanceof MaxCreditsExceeded && !input.tx)
      return {
        kind: 'max_credits_exceeded',
        required: error.required,
        maxCredits: error.maxCredits,
      }
    throw error
  }

  if (!prepared && (outcome.kind !== 'created' || outcome.taskId !== id))
    await discardArchivedInputs(id)
  if (outcome.kind === 'idempotency_conflict' && input.userId && commandId && !input.tx) {
    return (await adoptLegacyCommand(input.userId, commandId, hash, legacyHashes)) ?? outcome
  }
  return outcome
}

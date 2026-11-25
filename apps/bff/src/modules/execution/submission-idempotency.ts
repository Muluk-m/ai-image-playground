import { createHash } from 'node:crypto'
import type { SubmitRequest } from '@image-playground/shared'
import {
  applyPromptRewriteGuard,
  DEFAULT_IMAGE_MODERATION,
  GPT_IMAGE_26_GIF_DEFAULT_DURATION_MS,
  isGptImage26Model,
  shapeQueuePrompt,
} from '@image-playground/shared'
import { and, eq, gt, isNull, notInArray, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { canonicalJson } from '../../lib/canonicalJson'
import { isCapabilityEnabled } from '../../lib/capabilities'
import { modelCapabilities } from '../../lib/channels'
import { hydrateInputImages } from '../../lib/imageArchive'
import { asQueueProvider } from '../../lib/queueProvider'
import type { ExecutionTransaction } from './task-lifecycle-bus'
import { readTaskPayloads } from './task-payloads'
import type { CreateQueueTaskInput, CreateQueueTaskOutcome } from './task-submission-plugins'

/**
 * 同一个账号在这段时间里提交了一模一样的请求（命令 id 不同），当作手滑连点挡掉，不另建任务、不再扣费。
 * 连点两下的间隔远小于它；失败或取消的那条不算，立刻重试仍然放行。
 */
export const DUPLICATE_SUBMISSION_WINDOW_MS = 2_000

export async function findTaskByIdempotencyKey(clientRequestId: string, userId: string | null) {
  const ownerCondition = userId ? eq(schema.tasks.user_id, userId) : isNull(schema.tasks.user_id)
  const [task] = await db
    .select({ id: schema.tasks.id, submitted_at: schema.tasks.submitted_at })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.client_request_id, clientRequestId), ownerCondition))
    .limit(1)
  return task
}

export function commandHash(input: Omit<CreateQueueTaskInput, 'entry'>): string {
  const { device_id: _device, client_request_id: _command, ...request } = input.request
  const prompt = input.promptShaping?.originalPrompt ?? request.prompt
  const identityRequest = {
    ...request,
    prompt,
    n: request.n ?? 1,
    ...(!input.video && input.provider === 'openai-compat'
      ? { moderation: request.moderation ?? DEFAULT_IMAGE_MODERATION }
      : {}),
  }
  return createHash('sha256')
    .update(
      canonicalJson({
        provider: input.provider,
        model: input.model,
        request: identityRequest,
        video: input.video,
        ...(input.reconciliationRequired ? { reconciliationRequired: true } : {}),
        // Strict execution is server policy, not request identity; keep existing CLI receipts replayable.
        // 唤醒选择不是请求的一部分：同一条命令换个选择重放，仍是同一个任务。
        agent: input.agent && {
          conversationId: input.agent.conversationId,
          turnId: input.agent.turnId,
        },
        ...(input.stageAuthorization
          ? {
              stageAuthorization: {
                authorizationId: input.stageAuthorization.authorizationId,
                attemptId: input.stageAuthorization.attemptId,
                nodeId: input.stageAuthorization.nodeId,
              },
            }
          : {}),
      }),
    )
    .digest('hex')
}

function pushNoRewriteHashes(
  hashes: string[],
  input: CreateQueueTaskInput,
  request: SubmitRequest,
): void {
  if (request.no_rewrite === undefined) return
  const { no_rewrite, ...withoutOption } = request
  const legacyPrompt = shapeQueuePrompt({
    prompt: input.promptShaping?.originalPrompt ?? withoutOption.prompt,
    facts: {
      provider: input.provider,
      model: input.model,
      ...(withoutOption.size ? { size: withoutOption.size } : {}),
      ratio_via_prompt: Boolean(
        withoutOption.size && modelCapabilities(input.model)?.includes('size') === false,
      ),
    },
  })
  const legacyRequest = { ...withoutOption, prompt: legacyPrompt }
  hashes.push(commandHash({ ...input, promptShaping: undefined, request: legacyRequest }))
  if (no_rewrite && input.provider !== 'gemini')
    hashes.push(
      commandHash({
        ...input,
        promptShaping: undefined,
        request: { ...legacyRequest, prompt: applyPromptRewriteGuard(legacyPrompt) },
      }),
    )
  const optionedLegacyRequest = { ...legacyRequest, no_rewrite }
  hashes.push(commandHash({ ...input, promptShaping: undefined, request: optionedLegacyRequest }))
  if (no_rewrite && input.provider !== 'gemini')
    hashes.push(
      commandHash({
        ...input,
        promptShaping: undefined,
        request: { ...optionedLegacyRequest, prompt: applyPromptRewriteGuard(legacyPrompt) },
      }),
    )
}

/**
 * 旧任务的幂等哈希。默认 GIF 时长以前没写进载荷；no_rewrite 的几种提示词形态也要能认回。
 * 两者叠在同一单上时，缺时长的那份也要带上 no_rewrite 的每一种形态。
 */
export function legacyCommandHashes(input: CreateQueueTaskInput): string[] {
  const hashes: string[] = []
  const requests = [input.request]
  if (
    isGptImage26Model(input.model) &&
    input.request.output_format === 'gif' &&
    input.request.frame_duration_ms === GPT_IMAGE_26_GIF_DEFAULT_DURATION_MS
  ) {
    const { frame_duration_ms: _duration, ...withoutDuration } = input.request
    requests.push(withoutDuration)
    hashes.push(commandHash({ ...input, request: withoutDuration }))
  }
  for (const request of requests) pushNoRewriteHashes(hashes, input, request)
  return hashes
}

/**
 * 只挡创作页直出：画布节点（候选产物）、智能体工具、带授权的阶段提交和外部事务各有自己的批次语义，
 * 同一批里本就可能有内容相同的几条。免费部署的分发层会把多张拆成内容相同的几条，所以只在计费部署挡。
 */
export function dedupesRecentSubmission(
  input: CreateQueueTaskInput,
): input is CreateQueueTaskInput & {
  userId: string
} {
  return (
    !!input.dedupeRepeats &&
    !!input.userId &&
    !input.agent &&
    !input.stageAuthorization &&
    !input.tx &&
    input.request.output_retention !== 'candidate' &&
    isCapabilityEnabled('billing:credits')
  )
}

export async function lookupRecentDuplicate(
  database: Pick<typeof db, 'select'>,
  userId: string,
  hash: string,
) {
  const [recent] = await database
    .select({ taskId: schema.generation_commands.task_id })
    .from(schema.generation_commands)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.generation_commands.task_id))
    .where(
      and(
        eq(schema.generation_commands.user_id, userId),
        eq(schema.generation_commands.request_hash, hash),
        gt(schema.generation_commands.submitted_at, Date.now() - DUPLICATE_SUBMISSION_WINDOW_MS),
        notInArray(schema.tasks.status, ['failed', 'cancelled']),
      ),
    )
    .limit(1)
  return recent
}

export async function findRecentDuplicate(tx: ExecutionTransaction, userId: string, hash: string) {
  // 两条并发的连点在这把锁上排队：后到的那条一定看得到先到那条已提交的回执。
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['generation-recent', userId, hash])}, 0))`,
  )
  return lookupRecentDuplicate(tx, userId, hash)
}

export async function replayCommand(
  database: Pick<typeof db, 'select'>,
  userId: string,
  commandId: string,
  hash: string,
  legacyHashes: readonly string[] = [],
) {
  const [receipt] = await database
    .select()
    .from(schema.generation_commands)
    .where(
      and(
        eq(schema.generation_commands.user_id, userId),
        eq(schema.generation_commands.command_id, commandId),
      ),
    )
  if (!receipt) return null
  const matches = receipt.request_hash === hash || legacyHashes.includes(receipt.request_hash)
  return matches
    ? { kind: 'created' as const, taskId: receipt.task_id, submittedAt: receipt.submitted_at }
    : { kind: 'idempotency_mismatch' as const }
}

export async function adoptLegacyCommand(
  userId: string,
  commandId: string,
  hash: string,
  legacyHashes: readonly string[] = [],
): Promise<CreateQueueTaskOutcome | null> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['generation-command', userId, commandId])}, 0))`,
    )
    const replay = await replayCommand(tx, userId, commandId, hash, legacyHashes)
    if (replay) return replay
    const [task] = await tx
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.user_id, userId), eq(schema.tasks.client_request_id, commandId)))
      .limit(1)
      .for('update')
    if (!task) return null
    const payload = (await readTaskPayloads(tx, [task.id])).get(task.id)
    const requestPayload = payload ? payload.request_payload : task.request_payload
    const provider = asQueueProvider(task.provider)
    // 遮罩提交改写过原始请求，重建不回去，所以不认领。
    if (!provider || requestPayload.preserve_outside_mask) return { kind: 'idempotency_mismatch' }
    let originalHash: string
    try {
      const { video, ...restPayload } = requestPayload
      const { video: _video, ...request } = await hydrateInputImages(restPayload)
      originalHash = commandHash({
        provider,
        model: task.model,
        request,
        video,
        userId,
        ...(requestPayload.strict_image_request ? { strictImageRequest: true } : {}),
        ...(task.agent_conversation_id && task.agent_turn_id
          ? {
              agent: { conversationId: task.agent_conversation_id, turnId: task.agent_turn_id },
            }
          : {}),
      })
    } catch {
      return { kind: 'object_storage_error', message: 'Original task inputs could not be read' }
    }
    // The task lock prevents retention from deleting the identity before its receipt is durable.
    await tx.insert(schema.generation_commands).values({
      user_id: userId,
      command_id: commandId,
      request_hash: originalHash,
      task_id: task.id,
      submitted_at: task.submitted_at,
    })
    return originalHash === hash || legacyHashes.includes(originalHash)
      ? { kind: 'created', taskId: task.id, submittedAt: task.submitted_at }
      : { kind: 'idempotency_mismatch' }
  })
}

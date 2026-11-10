import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import type { AgentJobPlan } from '@image-playground/db'
import type {
  AgentBatchPriceSnapshot,
  ImageTierDecision,
  ImageTierEntry,
  ImageTierSnapshot,
  PersistedSubmitRequest,
  PersistedVideoRequest,
  QueueProvider,
  StageAuthorizationSubmission,
  SubmitRequest,
  TaskErrorType,
  TaskStatus,
} from '@image-playground/shared'
import {
  applyPromptRewriteGuard,
  billedStageQuantity,
  DEFAULT_IMAGE_MODERATION,
  GPT_IMAGE_26_GIF_DEFAULT_DURATION_MS,
  type GptImage26Rejection,
  gptImage26Rejection,
  gptImage26RejectionFields,
  imageSizeTier,
  isBlankPrompt,
  isGptImage26Model,
  nearestImageSize,
  QUEUE_TIMEOUTS,
  resolveImageTier,
  shapeQueuePrompt,
  stageAuthorizedVideoDuration,
  videoModelSupportOf,
  videoRateMultiplier,
} from '@image-playground/shared'
import { and, eq, gt, isNull, notInArray, sql } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'
import { publishGenerations } from '../db/generation-events'
import { prepareMaskedInput } from './agent/masked-input'
import { consumeStageAuthorization } from './agent/stage-authorizations'
import { canonicalJson } from './canonicalJson'
import { isCapabilityEnabled } from './capabilities'
import { declaredImageSizes, modelCapabilities } from './channels'
import { describeEmptyResult, type ExtractedResult, extractMeta } from './extractImages'
import { isActiveMember } from './gpt-membership'
import { archiveInputImages, hydrateInputImages, ObjectStorageError } from './imageArchive'
import { meteringDecisionOrDenied } from './metering-decision'
import { modelUnavailable } from './model-availability'
import { objectStore } from './objectStore'
import { type BffTransaction, loadPrivateBffOverlay } from './private-overlay'
import { reserveProjectOutputs } from './projectArchive'
import { lockMediaOwner } from './projectMedia'
import { publicTaskErrorMessage } from './public-task-error'
import { asQueueProvider } from './queueProvider'
import { type QuotaConsumeResult, tryConsumeQuotaInTransaction } from './quota'
import { isObject } from './type-guards'
import { gptDirectConfigured, gptImage26Configured } from './upstream/gpt-routing'

/**
 * 一条已经归档好输入的提交，只在本 module 内流转（见 `submitPrepared`）。
 * 档位决定随准备结果冻结：提交时沿用准备那一刻的会员位与收口后的请求，不再重查，
 * 准备和提交之间会员开通或到期不会让两边的请求对不上。4K 门禁仍在提交事务里按当时的会员资格判。
 */
interface PreparedQueueTask {
  readonly taskId: string
  readonly requestHash: string
  readonly requestPayload: PersistedSubmitRequest
  readonly alignment: ImageTierAlignment
}

interface ImageTierAlignment {
  readonly input: CreateQueueTaskInput
  readonly decision?: ImageTierDecision<SubmitRequest>
  readonly member: boolean
}

export interface CreateQueueTaskInput {
  /**
   * 从哪个入口提交，决定图片档位怎么收口（见 `resolveImageTier`）。调用方显式给出。
   */
  readonly entry: ImageTierEntry
  readonly stageAuthorization?: StageAuthorizationSubmission
  readonly provider: QueueProvider
  readonly model: string
  /** 输入图仍是 data URL，落库前在这里归档进对象存储。 */
  readonly request: Omit<SubmitRequest, 'video'>
  readonly video?: PersistedVideoRequest
  /** Original prompt and capability decision used to build the persisted queue prompt. */
  readonly promptShaping?: {
    readonly originalPrompt: string
    readonly ratioViaPrompt?: boolean
  }
  readonly userId: string | null
  /** 智能体工具提交时带上会话与轮，任务由此可反查属于哪一轮。 */
  readonly agent?: {
    readonly conversationId: string
    readonly turnId: string
    /**
     * 这是一个后台任务：与任务行同一个事务登记进 `agent_jobs`，结束时据此判断要不要唤醒智能体。
     * 登记与任务同生同灭，worker 再快也不会在登记之前把它跑完。
     */
    readonly job?: {
      readonly toolCallId: string
      readonly wakeOnSuccess: boolean
      /** 提交这一刻的改图计划；唤醒轮接着它走。 */
      readonly plan?: AgentJobPlan
    }
  }
  /**
   * 云端项目里这个任务要接替的失败占位（项目元素 id）：单张重试时产物落回原来那个位置。
   * 它不在项目里、或不是失败占位时照常另找位置。
   */
  readonly projectSlot?: string
  /**
   * 创作页 HTTP 直出：同账号几秒内内容一样的提交当作连点挡掉。
   * 其他入口（批量套用、智能体等）一批里本就可能有内容相同的几条，不开。
   */
  readonly dedupeRepeats?: true
  /** CLI preserves the requested tier/quality and rejects unavailable membership tiers instead of downgrading.
   * 与 `entry: 'cli-strict'` 同进同出，不一致直接抛错。 */
  readonly strictImageRequest?: true
  /**
   * 调用方给的积分上限（CLI 的 `max_credits`）。只在积分计费开着时生效；先按事务内报价
   * 拒绝，再以实际预扣兜底，超限时任务与预扣一并回滚。预算不是请求内容，不进命令哈希。
   */
  readonly maxCredits?: number
  /** Server-only opt-in; legacy HTTP submissions retain their existing lifecycle. */
  readonly reconciliationRequired?: true
  /**
   * 调用方自己的事务。给出时任务行、预扣、后台任务登记与调用方随后的写入同一次提交，
   * 也不会在已经握着一条连接时再去连接池要第二条（确认生成走这条路，见 `confirmations.ts`）。
   * 缺席即自开事务，与从前一样。
   */
  readonly tx?: BffTransaction
}

export type CreateQueueTaskOutcome =
  | { readonly kind: 'created'; readonly taskId: string; readonly submittedAt: number }
  | { readonly kind: 'idempotency_conflict' }
  | { readonly kind: 'idempotency_mismatch' }
  | { readonly kind: 'duplicate_submission'; readonly taskId: string }
  | { readonly kind: 'invalid_prompt' }
  | {
      readonly kind: 'invalid_image_request'
      readonly message: string
      readonly code: GptImage26Rejection
      readonly fields: readonly string[]
    }
  | { readonly kind: 'authentication_required' }
  | { readonly kind: 'metering_denied'; readonly reason: string }
  | { readonly kind: 'private_billing_denied' }
  | { readonly kind: 'insufficient_credits'; readonly required: number; readonly available: number }
  | {
      readonly kind: 'max_credits_exceeded'
      readonly required: number
      readonly maxCredits: number
    }
  | { readonly kind: 'price_unavailable'; readonly model: string }
  | { readonly kind: 'quota_exceeded'; readonly quota: QuotaConsumeResult }
  | { readonly kind: 'invalid_input_image'; readonly message: string }
  | { readonly kind: 'object_storage_error'; readonly message: string }

export async function findTaskByIdempotencyKey(clientRequestId: string, userId: string | null) {
  const ownerCondition = userId ? eq(schema.tasks.user_id, userId) : isNull(schema.tasks.user_id)
  const [task] = await db
    .select({ id: schema.tasks.id, submitted_at: schema.tasks.submitted_at })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.client_request_id, clientRequestId), ownerCondition))
    .limit(1)
  return task
}

/**
 * 计价单位数：图片是张数，视频是秒数；倍率跟着清晰度走。
 * 免费部署的每日配额按输出计数，所以一条视频算一次，不按秒数放大。
 */
function pricingOf(
  input: CreateQueueTaskInput,
  tier: ImageTierDecision<SubmitRequest> | undefined,
) {
  const n = input.request.n ?? 1
  if (!input.video)
    return {
      quantity: n,
      // 按即将落库的请求计价：倍率来自档位决定，提案、提交、结算共用同一份。
      unitMultiplier: tier?.rateMultiplier ?? 1,
      quotaUnits: n,
    }
  return {
    quantity: billedStageQuantity(input.video.duration_seconds),
    unitMultiplier: videoRateMultiplier(input.model, input.video.resolution),
    quotaUnits: 1,
  }
}

function commandHash(input: Omit<CreateQueueTaskInput, 'entry'>) {
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
/**
 * 同一个账号在这段时间里提交了一模一样的请求（命令 id 不同），当作手滑连点挡掉，不另建任务、不再扣费。
 * 连点两下的间隔远小于它；失败或取消的那条不算，立刻重试仍然放行。
 */
export const DUPLICATE_SUBMISSION_WINDOW_MS = 2_000

/**
 * 只挡创作页直出：画布节点（候选产物）、智能体工具、带授权的阶段提交和外部事务各有自己的批次语义，
 * 同一批里本就可能有内容相同的几条。免费部署的分发层会把多张拆成内容相同的几条，所以只在计费部署挡。
 */
function dedupesRecentSubmission(input: CreateQueueTaskInput): input is CreateQueueTaskInput & {
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

async function findRecentDuplicate(tx: BffTransaction, userId: string, hash: string) {
  // 两条并发的连点在这把锁上排队：后到的那条一定看得到先到那条已提交的回执。
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['generation-recent', userId, hash])}, 0))`,
  )
  const [recent] = await tx
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

async function replayCommand(
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

async function adoptLegacyCommand(
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
    const provider = asQueueProvider(task.provider)
    // 遮罩提交改写过原始请求，重建不回去，所以不认领。
    if (!provider || task.request_payload.preserve_outside_mask)
      return { kind: 'idempotency_mismatch' }
    let originalHash: string
    try {
      const { video, ...payload } = task.request_payload
      const { video: _video, ...request } = await hydrateInputImages(payload)
      originalHash = commandHash({
        provider,
        model: task.model,
        request,
        video,
        userId,
        ...(task.request_payload.strict_image_request ? { strictImageRequest: true } : {}),
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

/**
 * 「这是不是一次遮罩提交」只在这里判一次：`preserve_outside_mask` 与 `masked_original_size`
 * 描述同一个判定，要么都写、要么都不写，由这一个返回值保证。
 * 判据是请求里有没有选区，不是谁发的：画布与工作台直发的局部重绘同样要圈外像素不变，
 * 按提交方分叉会让同一个功能在两条路径上行为不一致。
 * `prepareMaskedInput` 不合规时抛 `TypeError`，由调用方翻成 `invalid_input_image`。
 */
async function prepareMaskedSubmission(input: CreateQueueTaskInput) {
  const request = input.request
  if (!request.mask || input.video) return undefined
  const strict = await prepareMaskedInput(
    input.model,
    request.input_images?.[0] ?? '',
    request.mask,
  )
  const { output_compression: _compression, ...rest } = request
  return {
    request: {
      ...rest,
      input_images: [strict.source, ...request.input_images!.slice(1)],
      mask: strict.mask,
      size: strict.size,
      // 保护选区外像素要逐像素比对，有损格式与压缩会把它毁掉。
      output_format: 'png' as const,
      // 局部编辑要一张完全不透明的图：带透明度的结果既合成不回原图，也过不了对齐校验。
      extra: { ...rest.extra, background: 'opaque' },
    },
    facts: {
      preserve_outside_mask: true as const,
      masked_original_size: strict.originalSize,
      ...(strict.crop ? { masked_crop: strict.crop } : {}),
    },
  }
}

/**
 * Read, transform and archive image bytes before acquiring caller transaction locks.
 * Prompt shaping stays here, after image/mask preparation, so mask-specific prompt notes are retained.
 * 预先准备的入口（批量执行、自动提交、灵感套用）的 `entry` 一律让 GPT 收到非会员上限，见 `resolveImageTier`。
 */
async function prepareQueueTask(input: CreateQueueTaskInput) {
  return prepareAlignedQueueTask(await alignImageTier(alignStageSubmission(input)))
}

async function prepareAlignedQueueTask(alignment: ImageTierAlignment) {
  const { input } = alignment
  const id = crypto.randomUUID()
  let requestPayload: PersistedSubmitRequest
  try {
    const masked = await prepareMaskedSubmission(input)
    const baseRequest = masked?.request ?? input.request
    const capabilities = modelCapabilities(input.model)
    const shaping =
      input.promptShaping && !input.video
        ? {
            original_prompt: input.promptShaping.originalPrompt,
            provider: input.provider,
            model: input.model,
            ...(baseRequest.size ? { size: baseRequest.size } : {}),
            ...(input.request.no_rewrite !== undefined
              ? { no_rewrite: input.request.no_rewrite }
              : {}),
            ratio_via_prompt:
              input.promptShaping.ratioViaPrompt ??
              Boolean(baseRequest.size && capabilities && !capabilities.includes('size')),
          }
        : undefined
    const request = shaping
      ? {
          ...baseRequest,
          prompt: shapeQueuePrompt({ prompt: baseRequest.prompt, facts: shaping }),
        }
      : baseRequest
    requestPayload = {
      ...(await archiveInputImages(id, request)),
      ...(input.video ? { video: input.video } : {}),
      ...masked?.facts,
      ...(shaping ? { prompt_shaping: shaping } : {}),
    }
    // The request body cannot opt into (or out of) the server's execution contract.
    delete requestPayload.strict_image_request
    if (input.strictImageRequest) requestPayload.strict_image_request = true
  } catch (error) {
    await discardArchivedInputs(id)
    if (error instanceof TypeError) {
      return { kind: 'invalid_input_image' as const, message: error.message }
    }
    return {
      kind: 'object_storage_error' as const,
      message:
        error instanceof ObjectStorageError ? error.message : 'Object storage input archive failed',
    }
  }
  if (input.provider === 'openai-compat' && !input.video) {
    requestPayload.moderation ??= DEFAULT_IMAGE_MODERATION
  }

  return {
    kind: 'prepared' as const,
    prepared: { taskId: id, requestHash: commandHash(input), requestPayload, alignment },
  }
}

export type PreparationRefusal = Extract<
  CreateQueueTaskOutcome,
  { kind: 'invalid_input_image' | 'object_storage_error' }
>

export type SubmitPreparedResult<T> =
  | { readonly kind: 'refused'; readonly index: number; readonly outcome: PreparationRefusal }
  | { readonly kind: 'committed'; readonly value: T }

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
    tx: BffTransaction,
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

/** 带授权的视频时长改成提案快照的同一档，再计价、落库。 */
function alignStageSubmission(input: CreateQueueTaskInput): CreateQueueTaskInput {
  if (!input.stageAuthorization || !input.video) return input
  const duration_seconds = stageAuthorizedVideoDuration(
    input.video.duration_seconds,
    videoModelSupportOf(input.model),
    input.video.resolution,
  )
  if (duration_seconds === input.video.duration_seconds) return input
  return { ...input, video: { ...input.video, duration_seconds } }
}

class MaxCreditsExceeded extends Error {
  constructor(
    readonly required: number,
    readonly maxCredits: number,
  ) {
    super('max_credits_exceeded')
  }
}

/** 这次请求落在 4K 档：Gemini 看 `image_size`，OpenAI 兼容的按 `size` 的像素数折算。 */
export function premiumTierRequested(
  provider: QueueProvider,
  request: Pick<SubmitRequest, 'image_size' | 'size'>,
): boolean {
  if (request.image_size === '4K') return true
  return provider === 'openai-compat' && !!request.size && imageSizeTier(request.size) === '4K'
}

/**
 * 4K 是会员权益，网站与 CLI 共用这一道。没带私有 overlay 的部署一律拒绝（空钩子返回 false）；
 * 还没实现这个钩子的旧 overlay 维持原状放行，overlay 发布后门禁随 `private.lock` 生效。
 */
export async function premiumRequestAllowed(
  tx: BffTransaction,
  userId: string,
  model: string,
  request: Pick<SubmitRequest, 'image_size' | 'size'>,
): Promise<boolean> {
  const { canSubmitTask } = (await loadPrivateBffOverlay()).taskHooks
  if (!canSubmitTask) return true
  // image_size 归一成档位：OpenAI 兼容模型只有像素 size，钩子仍按同一个「4K」判断。
  return canSubmitTask({
    tx,
    userId,
    model,
    request: { image_size: '4K', ...(request.size ? { size: request.size } : {}) },
  })
}

/**
 * CLI 不降级。GPT 的 2K、非高画质不要求订阅，但只有直连兑现得了，直连没开就拒绝。
 * 4K 或高画质仍要有效订阅。Gemini 只拦 4K。
 */
export async function strictImageRequestAllowed(
  tx: BffTransaction,
  userId: string,
  provider: QueueProvider,
  model: string,
  request: SubmitRequest,
): Promise<boolean> {
  const effectiveSize = provider === 'gemini' ? effectiveGeminiImageSize(request) : undefined
  const geminiSizes = provider === 'gemini' ? declaredImageSizes(model) : undefined
  if (provider === 'gemini' && effectiveSize === '4K' && geminiSizes?.length) {
    if (!geminiSizes.includes('4K')) return false
  }
  const { requires } = resolveImageTier({
    model,
    provider,
    request,
    entry: 'cli-strict',
    member: false,
    directAvailable: true,
  })
  if (requires.directRoute) {
    if (!gptDirectConfigured(model)) return false
    if (!requires.membership) return true
    // 4K 与高画质跟网站的 4K 用同一道订阅门。没有这道钩子的旧 overlay 不能授权严格请求。
    if (!(await loadPrivateBffOverlay()).taskHooks.canSubmitTask) return false
    return premiumRequestAllowed(tx, userId, model, request)
  }
  return !requires.membership || (await premiumRequestAllowed(tx, userId, model, request))
}

/**
 * Gemini 的最终有效档位来自扁平字段与 extra.generationConfig.imageConfig 的合并结果。
 * 提交边界先把它写回两处，避免报价、落库和上游构造各读不同的字段。
 */
function effectiveGeminiImageSize(request: SubmitRequest): string | undefined {
  const generationConfig = request.extra?.generationConfig
  if (!isObject(generationConfig) || !isObject(generationConfig.imageConfig))
    return request.image_size
  const imageSize = generationConfig.imageConfig.imageSize
  return typeof imageSize === 'string' ? imageSize : request.image_size
}

function withGeminiImageSize(request: SubmitRequest, imageSize: string): SubmitRequest {
  const generationConfig = request.extra?.generationConfig
  if (!isObject(generationConfig) || !isObject(generationConfig.imageConfig))
    return request.image_size === imageSize ? request : { ...request, image_size: imageSize }
  return {
    ...request,
    image_size: imageSize,
    extra: {
      ...(request.extra ?? {}),
      generationConfig: {
        ...generationConfig,
        imageConfig: { ...generationConfig.imageConfig, imageSize },
      },
    },
  }
}

function canonicalizeGeminiImageSize(request: SubmitRequest): SubmitRequest {
  const generationConfig = request.extra?.generationConfig
  if (!isObject(generationConfig) || !isObject(generationConfig.imageConfig)) return request
  const imageSize = generationConfig.imageConfig.imageSize
  if (typeof imageSize === 'string')
    return request.image_size !== imageSize ? withGeminiImageSize(request, imageSize) : request
  // extra.imageConfig 会整个替换扁平参数推导出的 imageConfig；不带 imageSize 时上游就丢了扁平档位，
  // 计价却仍按扁平档位。把扁平档位写进 extra，让上游发出的就是计价的那一档。
  return request.image_size ? withGeminiImageSize(request, request.image_size) : request
}

function normalizeGeminiImageSize(model: string, request: SubmitRequest): SubmitRequest {
  const canonical = canonicalizeGeminiImageSize(request)
  const requested = effectiveGeminiImageSize(canonical)
  if (requested === undefined) return canonical
  const declared = declaredImageSizes(model)
  const supported = declared?.length ? nearestImageSize(requested, declared) : requested
  if (!supported) return canonical
  return withGeminiImageSize(canonical, supported)
}

/**
 * 会员收口之后的 Gemini 请求形状整理：把最终档位写回扁平字段与 extra.imageConfig，再按渠道开放的档位取最近档。
 * 后面的计价和上游只看规整后的请求。
 */
function shapeGeminiAligned(model: string, membershipAligned: SubmitRequest): SubmitRequest {
  const alignedSize = membershipAligned.image_size ?? effectiveGeminiImageSize(membershipAligned)
  const canonicalAligned = alignedSize
    ? withGeminiImageSize(membershipAligned, alignedSize)
    : membershipAligned
  const request = normalizeGeminiImageSize(model, canonicalAligned)
  const finalSize = request.image_size ?? effectiveGeminiImageSize(request)
  return finalSize && effectiveGeminiImageSize(request) !== finalSize
    ? withGeminiImageSize(request, finalSize)
    : request
}

function tierSnapshot(
  entry: ImageTierEntry,
  member: boolean,
  decision: ImageTierDecision<SubmitRequest>,
): ImageTierSnapshot {
  return { entry, memberApplied: member, requires: decision.requires }
}

/**
 * 图片档位对齐的唯一入口，包住 `resolveImageTier`：
 * - 会员身份在这里查，且只在会员与否会改变结果时才查一次。
 * - Gemini 先规整 extra.imageConfig 与扁平档位，会员收口后再整理成上游要的形状（严格入口只规整，不降级）。
 * - 对整理后的最终请求再解一次，让 `requires` 与倍率对应真正落库的请求。
 * 视频没有档位决定，原样返回。
 */
async function alignImageTier(input: CreateQueueTaskInput): Promise<ImageTierAlignment> {
  if ((input.entry === 'cli-strict') !== (input.strictImageRequest === true))
    throw new TypeError('strict_image_request_entry_mismatch')
  if (input.video) return { input, member: false }
  const gemini = input.provider === 'gemini'
  const canonical = gemini ? canonicalizeGeminiImageSize(input.request) : input.request
  const base = {
    model: input.model,
    provider: input.provider,
    entry: input.entry,
    directAvailable: gptDirectConfigured(input.model),
    supportedTiers: declaredImageSizes(input.model),
  }
  const needsMember = !isDeepStrictEqual(
    resolveImageTier({ ...base, request: canonical, member: true }).effectiveRequest,
    resolveImageTier({ ...base, request: canonical, member: false }).effectiveRequest,
  )
  const member = needsMember ? await isActiveMember(input.userId) : false
  let request: SubmitRequest = resolveImageTier({
    ...base,
    request: canonical,
    member,
  }).effectiveRequest
  if (gemini && input.entry !== 'cli-strict') request = shapeGeminiAligned(input.model, request)
  // 对整理后的最终请求只取 requires 与倍率：会员位拉满，避免再收一次口把 Gemini 降回 2K，
  // 而 extra.imageConfig 与渠道取最近档的结果仍是 4K，落库、计价与上游发出的档位就错位了。
  const decision = resolveImageTier({ ...base, request, member: true })
  return {
    input: request === input.request ? input : { ...input, request },
    decision,
    member,
  }
}

const GPT_IMAGE_26_REJECTION_MESSAGE = {
  unavailable: 'Image 2.6 暂不可用',
  gif_edit: '带参考图时只能出静态图',
  svg_edit: '带参考图时只能出静态图',
  gif_count: '动图一次只能出一张',
  svg_count: '矢量一次只能出一张',
  gif_frames: '动图帧数只能是 2 到 16',
  gif_duration: '动图每帧时长无效',
  gif_sprite: '动图拼图超出当前尺寸限制，请改为 768 × 768、最多 12 帧，或 512 × 512、最多 16 帧',
  gif_size: '动图尺寸无效',
} as const

/** 2.6 的格式和雪碧图限制在建任务、扣积分之前拒绝。 */
function gptImage26RequestProblem(
  input: CreateQueueTaskInput,
): Extract<CreateQueueTaskOutcome, { kind: 'invalid_image_request' }> | null {
  if (!isGptImage26Model(input.model) || input.video) return null
  const reason = gptImage26Rejection(input.model, input.request, gptImage26Configured())
  if (!reason) return null
  return {
    kind: 'invalid_image_request',
    code: reason,
    fields: gptImage26RejectionFields(reason),
    message: GPT_IMAGE_26_REJECTION_MESSAGE[reason],
  }
}

export async function createQueueTask(raw: CreateQueueTaskInput): Promise<CreateQueueTaskOutcome> {
  return submitQueueTask(raw)
}

/**
 * `prepared` 只由 `submitPrepared` 传入：沿用准备时冻结的档位决定，归档的清理也归它。
 * 没有 `prepared` 时在这里对齐、归档，并自己清理。
 */
async function submitQueueTask(
  raw: CreateQueueTaskInput,
  prepared?: PreparedQueueTask,
): Promise<CreateQueueTaskOutcome> {
  // 预先准备的沿用冻结的请求与视频参数（带授权的视频时长在准备时已收口），只换上这次的事务。
  const aligned: ImageTierAlignment = prepared
    ? { ...prepared.alignment, input: { ...prepared.alignment.input, tx: raw.tx } }
    : await alignImageTier(alignStageSubmission(raw))
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
  const commandId = input.request.client_request_id
  const hash = commandHash(input)
  const legacyHashes: string[] = []
  // 旧 GIF 任务校验时按 200ms 放行，但没把默认时长写进载荷。补进请求后哈希变了，
  // 同一幂等键要仍能认回那条任务。
  if (
    isGptImage26Model(input.model) &&
    input.request.output_format === 'gif' &&
    input.request.frame_duration_ms === GPT_IMAGE_26_GIF_DEFAULT_DURATION_MS
  ) {
    const { frame_duration_ms: _duration, ...request } = input.request
    legacyHashes.push(commandHash({ ...input, request }))
  }
  if (input.request.no_rewrite !== undefined) {
    const { no_rewrite, ...request } = input.request
    const legacyPrompt = shapeQueuePrompt({
      prompt: input.promptShaping?.originalPrompt ?? request.prompt,
      facts: {
        provider: input.provider,
        model: input.model,
        ...(request.size ? { size: request.size } : {}),
        ratio_via_prompt: Boolean(
          request.size && modelCapabilities(input.model)?.includes('size') === false,
        ),
      },
    })
    const legacyRequest = { ...request, prompt: legacyPrompt }
    legacyHashes.push(commandHash({ ...input, promptShaping: undefined, request: legacyRequest }))
    if (no_rewrite && input.provider !== 'gemini')
      legacyHashes.push(
        commandHash({
          ...input,
          promptShaping: undefined,
          request: { ...legacyRequest, prompt: applyPromptRewriteGuard(legacyPrompt) },
        }),
      )
    const optionedLegacyRequest = { ...legacyRequest, no_rewrite }
    legacyHashes.push(
      commandHash({ ...input, promptShaping: undefined, request: optionedLegacyRequest }),
    )
    if (no_rewrite && input.provider !== 'gemini')
      legacyHashes.push(
        commandHash({
          ...input,
          promptShaping: undefined,
          request: { ...optionedLegacyRequest, prompt: applyPromptRewriteGuard(legacyPrompt) },
        }),
      )
  }
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
  const preparation = prepared
    ? { kind: 'prepared' as const, prepared }
    : await prepareAlignedQueueTask(aligned)
  if (preparation.kind !== 'prepared') return preparation
  const { taskId: id, requestPayload, requestHash } = preparation.prepared
  // 同一份冻结的对齐结果算出来的，不相等只能是 module 内部的 bug。
  if (requestHash !== hash) throw new TypeError('prepared_queue_request_mismatch')

  const now = Date.now()
  const pricing = pricingOf(input, aligned.decision)
  const taskHooks = (await loadPrivateBffOverlay()).taskHooks
  const dailyQuotaEnabled = isCapabilityEnabled('quota:daily')
  const dailyImageQuota = config.operator.quotas['generation:daily-images']
  const submit = async (tx: BffTransaction): Promise<CreateQueueTaskOutcome> => {
    let metering: {
      mode: 'credits' | 'none'
      model: string
      quantity: number
      unitMultiplier: number
      pricing?: AgentBatchPriceSnapshot
      tier?: ImageTierSnapshot
    } = {
      mode: isCapabilityEnabled('billing:credits') ? 'credits' : 'none',
      model: input.model,
      quantity: pricing.quantity,
      unitMultiplier: pricing.unitMultiplier,
      ...(aligned.decision
        ? { tier: tierSnapshot(input.entry, aligned.member, aligned.decision) }
        : {}),
    }
    let unmeteredByDecision = false
    const projectOutput =
      input.userId && input.agent && !input.video && isCapabilityEnabled('accounts:sync')
    if (projectOutput) await lockMediaOwner(tx, input.userId!)
    if (input.userId && commandId) {
      // A per-command transaction lock also covers the first submission, before a receipt exists.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['generation-command', input.userId, commandId])}, 0))`,
      )
      const replay = await replayCommand(tx, input.userId, commandId, hash, legacyHashes)
      if (replay) return replay
    }
    if (await modelUnavailable(tx, input.model)) {
      return { kind: 'price_unavailable' as const, model: input.model }
    }
    if (input.strictImageRequest) {
      if (!input.userId) return { kind: 'authentication_required' as const }
      if (
        !(await strictImageRequestAllowed(
          tx,
          input.userId,
          input.provider,
          input.model,
          input.request,
        ))
      )
        return { kind: 'private_billing_denied' as const }
    } else if (
      aligned.decision
        ? aligned.decision.requires.membership
        : premiumTierRequested(input.provider, input.request)
    ) {
      if (!input.userId) return { kind: 'authentication_required' as const }
      if (!(await premiumRequestAllowed(tx, input.userId, input.model, input.request)))
        return { kind: 'private_billing_denied' as const }
    }
    if (dedupesRecentSubmission(input)) {
      const duplicate = await findRecentDuplicate(tx, input.userId, hash)
      if (duplicate) return { kind: 'duplicate_submission' as const, taskId: duplicate.taskId }
    }
    if (input.userId) {
      const decision = meteringDecisionOrDenied(
        await taskHooks.meteringDecision?.({
          tx,
          userId: input.userId,
          model: input.model,
          kind: input.video ? 'video' : 'image',
          quantity: pricing.quantity,
          unitMultiplier: pricing.unitMultiplier,
        }),
        taskHooks.consumeUnmeteredQuota,
      )
      if (decision?.kind === 'denied')
        return { kind: 'metering_denied' as const, reason: decision.reason }
      if (decision?.kind === 'unmetered') {
        unmeteredByDecision = true
        metering = { ...metering, mode: 'none' }
      }
      if (decision?.kind === 'metered' && isCapabilityEnabled('billing:credits'))
        metering = {
          ...metering,
          mode: 'credits',
          ...(decision.pricing ? { pricing: decision.pricing } : {}),
        }
    }
    if (input.maxCredits !== undefined && metering.mode === 'credits') {
      const quote = await taskHooks.quoteTask?.({
        tx,
        userId: input.userId ?? '',
        model: input.model,
        quantity: pricing.quantity,
        unitMultiplier: pricing.unitMultiplier,
      })
      if (!quote) return { kind: 'price_unavailable' as const, model: input.model }
      if (quote.estimatedCredits > input.maxCredits)
        return {
          kind: 'max_credits_exceeded',
          required: quote.estimatedCredits,
          maxCredits: input.maxCredits,
        }
    }
    const inserted = await tx
      .insert(schema.tasks)
      .values({
        id,
        provider: input.provider,
        model: input.model,
        status: 'queued',
        reconciliation_required: input.reconciliationRequired ?? false,
        request_payload: requestPayload,
        submitted_at: now,
        user_id: input.userId,
        client_request_id: input.request.client_request_id ?? null,
        agent_conversation_id: input.agent?.conversationId ?? null,
        agent_turn_id: input.agent?.turnId ?? null,
        metering,
      })
      .onConflictDoNothing()
      .returning({ id: schema.tasks.id, submitted_at: schema.tasks.submitted_at })

    if (inserted.length === 0) return { kind: 'idempotency_conflict' as const }

    let reservedCredits = 0
    if (metering.mode === 'credits') {
      if (!input.userId) {
        await tx.delete(schema.tasks).where(eq(schema.tasks.id, id))
        return { kind: 'authentication_required' as const }
      }
      const reservation = await taskHooks.reserveTask({
        tx,
        taskId: id,
        userId: input.userId,
        model: input.model,
        quantity: pricing.quantity,
        unitMultiplier: pricing.unitMultiplier,
      })
      if (reservation.kind !== 'reserved') {
        await tx.delete(schema.tasks).where(eq(schema.tasks.id, id))
        if (reservation.kind === 'access_denied')
          return { kind: 'metering_denied' as const, reason: reservation.reason }
        if (reservation.kind === 'quota_exceeded')
          return {
            kind: 'quota_exceeded' as const,
            quota: {
              ok: false,
              count: reservation.used,
              quota: reservation.quota,
              reset_at: reservation.resetAt,
            },
          }
        return reservation
      }
      reservedCredits = reservation.credits
      // 报价与预扣同在这个事务里，正常应一致；预扣按自己的规则算出更多时以它为准，
      // 抛出去让整个事务回滚，任务与预扣一起撤销。
      if (input.maxCredits !== undefined && reservedCredits > input.maxCredits)
        throw new MaxCreditsExceeded(reservedCredits, input.maxCredits)
    } else if (unmeteredByDecision && input.userId && taskHooks.consumeUnmeteredQuota) {
      const quota = await taskHooks.consumeUnmeteredQuota({
        tx,
        userId: input.userId,
        model: input.model,
        kind: input.video ? 'video' : 'image',
        quantity: pricing.quantity,
        unitMultiplier: pricing.unitMultiplier,
      })
      if (quota.kind === 'quota_exceeded') {
        await tx.delete(schema.tasks).where(eq(schema.tasks.id, id))
        return {
          kind: 'quota_exceeded' as const,
          quota: {
            ok: false,
            count: quota.used,
            quota: quota.quota,
            reset_at: quota.resetAt,
          },
        }
      }
    } else if (dailyQuotaEnabled) {
      const quota = await tryConsumeQuotaInTransaction(
        tx,
        input.request.device_id ?? '',
        pricing.quotaUnits,
        dailyImageQuota,
      )
      if (!quota.ok) {
        await tx.delete(schema.tasks).where(eq(schema.tasks.id, id))
        return { kind: 'quota_exceeded' as const, quota }
      }
    }
    if (input.stageAuthorization)
      await consumeStageAuthorization(
        tx,
        input.userId,
        input.stageAuthorization,
        id,
        {
          model: input.model,
          quantity: pricing.quantity,
          unitMultiplier: pricing.unitMultiplier,
        },
        reservedCredits,
        {
          prompt: input.request.prompt,
          inputCount: requestPayload.input_images?.length ?? 0,
          // 指纹用归一化后的计价数量，和提案快照是同一个数。1.9 秒在带授权时已经收成合法档。
          ...(input.video
            ? {
                video: {
                  durationSeconds: pricing.quantity,
                  resolution: input.video.resolution,
                  aspectRatio: input.video.aspect_ratio,
                },
              }
            : {}),
        },
        // 创作页分发层会给图片 prompt 钉防改写前缀 / 构图后缀，授权冻结的是原文。
        // 视频提交原样发冻结的 prompt，不放宽。
        input.video
          ? undefined
          : {
              provider: input.provider,
              model: input.model,
              ...(input.request.size ? { size: input.request.size } : {}),
            },
      )
    if (input.userId && commandId)
      await tx.insert(schema.generation_commands).values({
        user_id: input.userId,
        command_id: commandId,
        request_hash: hash,
        task_id: id,
        submitted_at: now,
      })
    if (projectOutput)
      await reserveProjectOutputs(tx, {
        userId: input.userId!,
        generationId: id,
        conversationId: input.agent!.conversationId,
        turnId: input.agent!.turnId,
        count: input.request.n ?? 1,
        ...(input.projectSlot ? { replaceObjectId: input.projectSlot } : {}),
      })
    if (input.agent?.job)
      await tx.insert(schema.agent_jobs).values({
        task_id: id,
        conversation_id: input.agent.conversationId,
        turn_id: input.agent.turnId,
        tool_call_id: input.agent.job.toolCallId,
        wake_on_success: input.agent.job.wakeOnSuccess,
        plan: input.agent.job.plan ?? null,
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

/** 没有任务行引用这个前缀了；删不掉也只是留个孤儿，由 bucket lifecycle 收。 */
async function discardArchivedInputs(taskId: string): Promise<void> {
  try {
    await objectStore().deletePrefix(`${taskId}/in/`)
  } catch {
    // Bucket lifecycle cleanup removes any orphan.
  }
}

/** 队列任务的终态。`extractMeta` 的结果只在 completed 时有意义。 */
export type QueueTaskOutcome =
  | { readonly kind: 'completed'; readonly result: ExtractedResult }
  | {
      readonly kind: 'failed'
      readonly reason: string
      /** worker 记下的失败类型；等超时记 `upstream_timeout`，完成却没图记 `upstream_no_image`。 */
      readonly errorType: TaskErrorType | null
      /** 任务被取消（轮中止、会话删除），不是上游失败。 */
      readonly cancelled?: true
      /** 等待预算用完时任务还没到终态：它可能仍在跑、仍会出图计费，由调用方决定怎么收场。 */
      readonly stillRunning?: true
    }

/** 读一条队列任务的终局要用到的那几列。 */
export interface QueueTaskTerminalRow {
  readonly status: TaskStatus
  readonly provider: string
  readonly result_payload: unknown
  readonly error_message: string | null
  readonly error_type: string | null
}

/** 任务行此刻的终局；还没到终态就是 null。等结果与后台任务结算读的是同一个算式。 */
export function queueTaskOutcome(task: QueueTaskTerminalRow): QueueTaskOutcome | null {
  if (task.status === 'failed') {
    return {
      kind: 'failed',
      reason: publicTaskErrorMessage(task.error_message ?? '任务失败'),
      // 列是自由文本；写它的只有 worker，值域就是 `TaskErrorType`。
      errorType: (task.error_type as TaskErrorType | null) ?? null,
    }
  }
  if (task.status === 'cancelled')
    return { kind: 'failed', reason: '任务被取消了', errorType: null, cancelled: true }
  if (task.status === 'completed') {
    const provider = asQueueProvider(task.provider)
    if (!provider)
      return { kind: 'failed', reason: `未知的上游：${task.provider}`, errorType: 'unknown' }
    const result = extractMeta(provider, task.result_payload)
    if (result.images.length === 0) {
      return {
        kind: 'failed',
        reason: describeEmptyResult(provider, task.result_payload),
        errorType: 'upstream_no_image',
      }
    }
    return { kind: 'completed', result }
  }
  return null
}

interface Polling {
  readonly intervalMs: number
  readonly budgetMs: number
}

const DEFAULT_POLLING: Polling = { intervalMs: 1_000, budgetMs: QUEUE_TIMEOUTS.POLL_MAX_MS }

let polling = DEFAULT_POLLING

/** 测试注入点；不传恢复真实节奏。 */
export function setQueueTaskPollingForTesting(next?: Partial<Polling>): void {
  polling = next ? { ...DEFAULT_POLLING, ...next } : DEFAULT_POLLING
}

/** 越等越慢：任务刚提交那几秒 worker 还没轮到它，密集查只是空转。 */
function nextInterval(waitedMs: number): number {
  const step = waitedMs < 5_000 ? 1 : waitedMs < 20_000 ? 2 : 5
  return polling.intervalMs * step
}

/**
 * 等一条队列任务跑到终态。进程内轮询任务表，与 worker 的调度轮询各管各的。
 * `onStatus` 每次状态变化报一次，供调用方把进度推给用户。
 */
export async function awaitQueueTask(
  taskId: string,
  options: {
    readonly signal?: AbortSignal
    readonly onStatus?: (status: TaskStatus) => void
  } = {},
): Promise<QueueTaskOutcome> {
  const startedAt = Date.now()
  let announced: TaskStatus | undefined
  while (true) {
    if (options.signal?.aborted) throw new Error('这一轮被中止了')
    const [task] = await db
      .select({
        status: schema.tasks.status,
        provider: schema.tasks.provider,
        result_payload: schema.tasks.result_payload,
        error_message: schema.tasks.error_message,
        error_type: schema.tasks.error_type,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .limit(1)
    if (!task) return { kind: 'failed', reason: '任务丢失了', errorType: 'unknown' }

    if (task.status !== announced) {
      announced = task.status
      options.onStatus?.(task.status)
    }
    const settled = queueTaskOutcome(task)
    if (settled) return settled

    const waited = Date.now() - startedAt
    if (waited > polling.budgetMs)
      return {
        kind: 'failed',
        reason: '超时未返回',
        errorType: 'upstream_timeout',
        stillRunning: true,
      }
    await delay(nextInterval(waited), undefined, { signal: options.signal })
  }
}

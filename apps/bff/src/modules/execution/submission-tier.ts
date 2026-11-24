import { isDeepStrictEqual } from 'node:util'
import type {
  ImageTierDecision,
  ImageTierEntry,
  ImageTierSnapshot,
  QueueProvider,
  SubmitRequest,
} from '@image-playground/shared'
import {
  billedStageQuantity,
  degradeGptImage26ForSub2api,
  gptImage26Rejection,
  gptImage26RejectionFields,
  gptImage26RequiresDirect,
  imageSizeTier,
  isGptImage26Model,
  isGptSub2apiDeliverable,
  nearestImageSize,
  resolveImageTier,
  stageAuthorizedVideoDuration,
  videoModelSupportOf,
  videoRateMultiplier,
} from '@image-playground/shared'
import { type BffTransaction, loadEntitlementPort } from '../../lib/billing-ports'
import { declaredImageSizes } from '../../lib/channels'
import { isActiveMember } from '../../lib/gpt-membership'
import { isObject } from '../../lib/type-guards'
import { gptDirectConfigured, gptImage26DirectKey } from '../../lib/upstream/gpt-routing'
import type {
  CreateQueueTaskInput,
  CreateQueueTaskOutcome,
  TaskPricingUnits,
} from './task-submission-plugins'

export interface ImageTierAlignment {
  readonly input: CreateQueueTaskInput
  readonly decision?: ImageTierDecision<SubmitRequest>
  readonly member: boolean
}

/**
 * 计价单位数：图片是张数，视频是秒数；倍率跟着清晰度走。
 * 免费部署的每日配额按输出计数，所以一条视频算一次，不按秒数放大。
 */
export function pricingOf(
  input: CreateQueueTaskInput,
  tier: ImageTierDecision<SubmitRequest> | undefined,
): TaskPricingUnits {
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

/** 带授权的视频时长改成提案快照的同一档，再计价、落库。 */
export function alignStageSubmission(input: CreateQueueTaskInput): CreateQueueTaskInput {
  if (!input.stageAuthorization || !input.video) return input
  const duration_seconds = stageAuthorizedVideoDuration(
    input.video.duration_seconds,
    videoModelSupportOf(input.model),
    input.video.resolution,
  )
  if (duration_seconds === input.video.duration_seconds) return input
  return { ...input, video: { ...input.video, duration_seconds } }
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
 * 4K 是会员权益，网站与 CLI 共用这一道。未启用计费扩展的部署一律拒绝（空钩子返回 false）。
 */
export async function premiumRequestAllowed(
  tx: BffTransaction,
  userId: string,
  model: string,
  request: Pick<SubmitRequest, 'image_size' | 'size'>,
): Promise<boolean> {
  const { canSubmitTask } = await loadEntitlementPort()
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
    // 4K 与高画质跟网站的 4K 用同一道订阅门。没有这道钩子的部署不能授权严格请求。
    if (!(await loadEntitlementPort()).canSubmitTask) return false
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

export function tierSnapshot(
  entry: ImageTierEntry,
  member: boolean,
  decision: ImageTierDecision<SubmitRequest>,
): ImageTierSnapshot {
  return { entry, memberApplied: member, requires: decision.requires }
}

const GPT_IMAGE_26_DIRECT_ONLY_MESSAGE = '动图和矢量图需要 OpenAI 直连，当前直连不可用'
const GPT_IMAGE_26_TIER_MESSAGE = '当前高分辨率/高画质需要 OpenAI 直连，暂不可用'

export const GPT_IMAGE_26_REJECTION_MESSAGE = {
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

/** 严格入口不降级：直连接不了高档或动图时，按原来的拒绝交回去。 */
export async function strictImage26Refusal(
  input: CreateQueueTaskInput,
): Promise<Extract<CreateQueueTaskOutcome, { kind: 'model_unavailable' }> | null> {
  if (!input.strictImageRequest || !isGptImage26Model(input.model) || input.video) return null
  if (await gptImage26DirectKey(input.model, input.request)) return null
  if (gptImage26RequiresDirect(input.request))
    return { kind: 'model_unavailable', message: GPT_IMAGE_26_DIRECT_ONLY_MESSAGE }
  if (!isGptSub2apiDeliverable(input.request))
    return { kind: 'model_unavailable', message: GPT_IMAGE_26_TIER_MESSAGE }
  return null
}

/**
 * 直连接不了时改落库请求和倍率。幂等哈希仍用降级前的请求，直连开关来回翻不会变成另一单。
 * 严格入口保持原请求。
 */
export async function degradeImage26Alignment(
  aligned: ImageTierAlignment,
): Promise<ImageTierAlignment> {
  const input = aligned.input
  if (input.strictImageRequest || input.video || !isGptImage26Model(input.model)) return aligned
  if (await gptImage26DirectKey(input.model, input.request)) return aligned
  const degraded = degradeGptImage26ForSub2api(input.request)
  if (!degraded) return aligned
  const request: SubmitRequest = {
    ...degraded.request,
    image26_degrade: { kind: degraded.kind, fields: degraded.fields },
  }
  const decision = resolveImageTier({
    model: input.model,
    provider: input.provider,
    entry: input.entry,
    request,
    member: true,
    directAvailable: false,
    supportedTiers: declaredImageSizes(input.model),
  })
  return { input: { ...input, request }, decision, member: aligned.member }
}

/**
 * 图片档位对齐的唯一入口，包住 `resolveImageTier`：
 * - 会员身份在这里查，且只在会员与否会改变结果时才查一次。
 * - Gemini 先规整 extra.imageConfig 与扁平档位，会员收口后再整理成上游要的形状（严格入口只规整，不降级）。
 * - 对整理后的最终请求再解一次，让 `requires` 与倍率对应真正落库的请求。
 * 视频没有档位决定，原样返回。
 */
export async function alignImageTier(input: CreateQueueTaskInput): Promise<ImageTierAlignment> {
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

/**
 * 2.6 的格式和雪碧图限制在建任务、扣积分之前拒绝。
 * 直连不可用时请求已经收成 1K 静态图，这里只校验直连仍要出的 GIF / SVG。
 */
export function gptImage26RequestProblem(
  input: CreateQueueTaskInput,
): Extract<CreateQueueTaskOutcome, { kind: 'invalid_image_request' }> | null {
  if (!isGptImage26Model(input.model) || input.video) return null
  const reason = gptImage26Rejection(input.model, input.request, true)
  if (!reason || reason === 'unavailable') return null
  return {
    kind: 'invalid_image_request',
    code: reason,
    fields: gptImage26RejectionFields(reason),
    message: GPT_IMAGE_26_REJECTION_MESSAGE[reason],
  }
}

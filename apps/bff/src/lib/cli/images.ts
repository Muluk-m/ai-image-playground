import { createHash } from 'node:crypto'
import {
  GPT_IMAGE_26_GIF_DEFAULT_DURATION_MS,
  GPT_IMAGE_26_GIF_DURATIONS_MS,
  GPT_IMAGE_26_GIF_FRAME_MAX,
  GPT_IMAGE_26_GIF_FRAME_MIN,
  GPT_IMAGE_26_GIF_FRAMES,
  GPT_IMAGE_26_GIF_SIZES,
  type GptImage26Rejection,
  gifSpriteExceedsLimit,
  gptImage26Rejection,
  imageRateMultiplier,
  isGptDirectModel,
  isGptImage26Model,
  type QueueProvider,
  type SubmitRequest,
} from '@image-playground/shared'
import {
  findCatalogModel,
  type ImageRequestAdjustment,
  type ModelSpec,
  resolveImageRequest,
} from '@image-playground/shared/model-catalog'
import { and, eq, inArray, like } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { accountConcurrencyLimit } from '../account-concurrency'
import { shapeQueuePrompt } from '../agent/prompt-shaping'
import { canonicalJson } from '../canonicalJson'
import { declaredImageSizes, getDiscoveredChannels, resolveQueueModel } from '../channels'
import { refreshInactiveModels, withoutInactiveModels } from '../model-availability'
import { loadPrivateBffOverlay } from '../private-overlay'
import { strictImageRequestAllowed } from '../taskSubmission'
import { gptDirectConfigured } from '../upstream/gpt-routing'
import { CliRequestError } from './envelope'

export const CLI_PROMPT_MAX_CHARS = 32_000

interface CliImageModel {
  readonly id: string
  readonly label: string
  readonly provider: QueueProvider
  /** 能力目录的图片能力，档位再按渠道声明的 `imageSizes` 收窄，与网站可选的档位一致。 */
  readonly image: ModelSpec['image']
  readonly etaSeconds?: number
}

/**
 * 与网站模型选择器同一份清单、同一个顺序：`/api/channels` 去掉运营下架的模型后，
 * 只留能力目录里登记过的图片模型。第一个就是默认模型，和网站新访客的默认一致。
 */
export async function availableImageModels(): Promise<CliImageModel[]> {
  const channels = withoutInactiveModels(getDiscoveredChannels(), await refreshInactiveModels())
  return channels.flatMap((channel) =>
    channel.models.flatMap((model) => {
      if ((model.media ?? 'image') !== 'image') return []
      const spec = findCatalogModel(model.id)
      const queue = resolveQueueModel('image', model.id)
      if (!spec || !queue) return []
      const declared: readonly string[] | undefined = model.imageSizes
      const tiers = declared
        ? spec.image.tiers.filter((tier) => declared.includes(tier.id))
        : spec.image.tiers
      if (!tiers.length) return []
      const image = {
        ...spec.image,
        tiers,
        defaultTier: tiers.some((tier) => tier.id === spec.image.defaultTier)
          ? spec.image.defaultTier
          : tiers[0]!.id,
      }
      return [
        {
          id: model.id,
          label: model.label,
          provider: queue.provider,
          image,
          ...(model.etaSeconds === undefined ? {} : { etaSeconds: model.etaSeconds }),
        },
      ]
    }),
  )
}

/** 普通图片之外，能直接出的格式。`image` 表示模型的常规图片输出。 */
export type CliOutputFormat = 'image' | 'gif' | 'svg'

const GIF_DEFAULT_FRAMES = 6
const GIF_DEFAULT_SIZE = '768x768'

/** 与网站一致：只有 GPT Image 2.6 能直出 GIF / SVG，规则见 `gpt-image-26.ts`。 */
export function outputFormatsFor(model: string): readonly CliOutputFormat[] {
  return isGptImage26Model(model) ? ['image', 'gif', 'svg'] : ['image']
}

export interface CliImageRequestBody {
  readonly prompt: string
  readonly model?: string
  readonly aspect_ratio?: string
  readonly image_size?: string
  readonly quality?: string
  readonly reference_media_ids?: readonly string[]
  readonly output_format?: string
  readonly frame_count?: number
  readonly frame_duration_ms?: number
  readonly frame_size?: string
}

export interface NormalizedImageRequest {
  readonly prompt: string
  readonly model: string
  readonly aspect_ratio: string
  readonly image_size: string
  readonly quality?: string
  readonly reference_media_ids: readonly string[]
  readonly count: 1
  // 只在 GIF / SVG 时出现：普通图片的规整结果与哈希和以前完全一样。
  readonly output_format?: 'gif' | 'svg'
  readonly frame_count?: number
  readonly frame_duration_ms?: number
  readonly frame_size?: string
}

const OUTPUT_REJECTION: Record<GptImage26Rejection, string> = {
  unavailable: 'this model is not available right now',
  gif_edit: 'gif output does not accept reference images',
  svg_edit: 'svg output does not accept reference images',
  gif_count: 'gif output makes one image per request',
  svg_count: 'svg output makes one image per request',
  gif_frames: `frame_count must be an integer from ${GPT_IMAGE_26_GIF_FRAME_MIN} to ${GPT_IMAGE_26_GIF_FRAME_MAX}`,
  gif_duration: 'frame_duration_ms must be a multiple of 10 from 20 to 2000',
  gif_sprite:
    'too many frames for this frame_size: use 768x768 with at most 12 frames, or 512x512 with at most 16',
  gif_size: `frame_size must be one of ${GPT_IMAGE_26_GIF_SIZES.join(', ')}`,
}

/** GIF / SVG 参数的规整与校验，规则直接复用网站的 `gptImage26Rejection`，不建任务、不预扣。 */
function outputFormatFields(
  body: CliImageRequestBody,
  model: CliImageModel,
  references: number,
): Pick<
  NormalizedImageRequest,
  'output_format' | 'frame_count' | 'frame_duration_ms' | 'frame_size'
> {
  const format = body.output_format ?? 'image'
  const available = outputFormatsFor(model.id)
  if (!(available as readonly string[]).includes(format))
    throw new CliRequestError('INVALID_REQUEST', {
      message: `model does not support output_format ${format}`,
      details: { available },
    })
  const gifOnly =
    body.frame_count !== undefined ||
    body.frame_duration_ms !== undefined ||
    body.frame_size !== undefined
  if (format !== 'gif') {
    if (gifOnly)
      throw new CliRequestError('INVALID_REQUEST', {
        message: 'frame_count, frame_duration_ms and frame_size apply to output_format gif only',
      })
    if (format === 'image') return {}
  }
  if (format === 'gif' && (body.image_size !== undefined || body.aspect_ratio !== undefined))
    throw new CliRequestError('INVALID_REQUEST', {
      message: 'gif output uses frame_size instead of image_size and aspect_ratio',
    })
  if (body.quality !== undefined)
    throw new CliRequestError('INVALID_REQUEST', {
      message: `${format} output does not take quality`,
    })
  const gif =
    format === 'gif'
      ? {
          frame_count: body.frame_count ?? GIF_DEFAULT_FRAMES,
          frame_duration_ms: body.frame_duration_ms ?? GPT_IMAGE_26_GIF_DEFAULT_DURATION_MS,
          frame_size: body.frame_size ?? GIF_DEFAULT_SIZE,
        }
      : {}
  const reason = gptImage26Rejection(
    model.id,
    {
      output_format: format,
      n: 1,
      input_images: Array.from({ length: references }),
      ...(gif.frame_count === undefined
        ? {}
        : {
            frame_count: gif.frame_count,
            frame_duration_ms: gif.frame_duration_ms,
            // 帧尺寸只有两档；其它尺寸先按网站规则拒掉，再交给拼图上限判断。
            size: (GPT_IMAGE_26_GIF_SIZES as readonly string[]).includes(gif.frame_size)
              ? gif.frame_size
              : undefined,
          }),
    },
    true,
  )
  if (reason)
    throw new CliRequestError('INVALID_REQUEST', {
      message: OUTPUT_REJECTION[reason],
      ...(format === 'gif'
        ? {
            details: {
              frame_sizes: GPT_IMAGE_26_GIF_SIZES,
              frame_count: { min: GPT_IMAGE_26_GIF_FRAME_MIN, max: GPT_IMAGE_26_GIF_FRAME_MAX },
            },
          }
        : {}),
    })
  // 走到这里只剩 gif / svg：image 在上面已经返回。
  return { output_format: format as 'gif' | 'svg', ...gif }
}

export interface PreparedImageRequest {
  readonly normalized: NormalizedImageRequest
  /** 规整后请求的哈希：预检与提交对同一组参数给出同一个值。 */
  readonly requestHash: string
  readonly adjustments: readonly ImageRequestAdjustment[]
  readonly model: CliImageModel
}

/** 纯参数规整：不读媒体、不查价、不碰账号。回落规则与网站共用 `resolveImageRequest`。 */
export function normalizeImageRequest(
  body: CliImageRequestBody,
  models: readonly CliImageModel[],
): PreparedImageRequest {
  const prompt = body.prompt.trim()
  if (!prompt) throw new CliRequestError('INVALID_REQUEST', { message: 'prompt is required' })
  const model = body.model ? models.find((one) => one.id === body.model) : models[0]
  if (!model)
    throw new CliRequestError('INVALID_REQUEST', {
      message: 'model is not available',
      details: { available: models.map((one) => one.id) },
    })
  const references = [...new Set(body.reference_media_ids ?? [])]
  const output = outputFormatFields(body, model, references.length)
  const caps = model.image
  if (references.length && !caps.operations.includes('edit'))
    throw new CliRequestError('INVALID_REQUEST', {
      message: 'model does not accept reference images',
    })
  const resolved = resolveImageRequest(caps, {
    tier: body.image_size,
    ratio: body.aspect_ratio,
    n: 1,
    references: references.length,
    surface: 'direct',
  })
  if (!resolved.ok)
    throw new CliRequestError('INVALID_REQUEST', {
      message: 'too many reference images',
      details: { max: resolved.max },
    })
  // A pixel-addressed GPT request cannot express a premium tier with size=auto. Resolve it to
  // square pixels once, so the normalized preview, price, command hash and stored task all agree.
  const concreteGptRatio =
    isGptDirectModel(model.id) && resolved.tier !== '1K' && resolved.ratio === 'auto'
  const ratio = concreteGptRatio ? '1:1' : resolved.ratio
  const qualities: readonly string[] = caps.quality?.values ?? []
  if (!output.output_format && body.quality && !qualities.includes(body.quality))
    throw new CliRequestError('INVALID_REQUEST', {
      message: 'unsupported quality',
      details: { available: qualities },
    })
  // GIF / SVG 与网站一样固定中等画质；GIF 的尺寸由 frame_size 决定。
  const quality = output.output_format
    ? 'medium'
    : alignResolutionQuality(caps, resolved.tier, body.quality)
  const normalized: NormalizedImageRequest = {
    prompt,
    model: model.id,
    aspect_ratio: output.output_format === 'gif' ? '1:1' : ratio,
    image_size: output.output_format === 'gif' ? '1K' : resolved.tier,
    ...(quality && quality !== 'auto' ? { quality } : {}),
    reference_media_ids: references,
    count: 1,
    ...output,
  }
  return {
    normalized,
    requestHash: createHash('sha256').update(canonicalJson(normalized)).digest('hex'),
    adjustments: concreteGptRatio
      ? [...resolved.adjustments, { field: 'ratio', from: 'auto', to: ratio }]
      : resolved.adjustments,
    model,
  }
}

/**
 * 上游按 quality 决定分辨率的模型（Grok：`high` 才是 2K，见 `upstream/grok.ts`）：档位与 quality
 * 必须一致，否则预检确认的档位到上游会被悄悄换掉。2K 自动带上 high；明确冲突的组合直接拒绝。
 */
function alignResolutionQuality(
  caps: ModelSpec['image'],
  tier: string,
  quality: string | undefined,
): string | undefined {
  if (caps.wire.kind !== 'tier-token' || caps.wire.param !== 'resolution') return quality
  const wantsHigh = tier === '2K'
  if (!quality || quality === 'auto') return wantsHigh ? 'high' : quality
  if ((quality === 'high') !== wantsHigh)
    throw new CliRequestError('INVALID_REQUEST', {
      message: wantsHigh
        ? 'image_size 2K requires quality high on this model'
        : 'quality high produces 2K on this model; set image_size 2K',
    })
  return quality
}

/** 规整后的请求 → 队列请求字段，与网站 `queueClient.submit` 的分支保持同一套写法。 */
export function toSubmitRequest(prepared: PreparedImageRequest): SubmitRequest {
  const { normalized, model } = prepared
  const ratio = normalized.aspect_ratio
  const tier = model.image.tiers.find((one) => one.id === normalized.image_size)
  const pixels = ratio === 'auto' ? undefined : tier?.pixels[ratio as keyof typeof tier.pixels]
  const request: SubmitRequest = {
    no_rewrite: model.provider !== 'gemini',
    prompt: shapeQueuePrompt({
      provider: model.provider,
      model: model.id,
      prompt: normalized.prompt,
      ...(pixels ? { size: pixels } : {}),
    }),
    n: 1,
  }
  if (model.provider === 'gemini') {
    if (ratio !== 'auto') request.aspect_ratio = ratio
    request.image_size = normalized.image_size as SubmitRequest['image_size']
  } else {
    if (pixels) request.size = pixels
    if (normalized.quality) request.quality = normalized.quality as SubmitRequest['quality']
  }
  if (normalized.reference_media_ids.length)
    request.input_images = normalized.reference_media_ids.map((id) => `aip-media:${id}`)
  if (normalized.output_format) {
    request.output_format = normalized.output_format
    request.quality = 'medium'
  }
  if (normalized.output_format === 'gif') {
    request.size = normalized.frame_size
    request.frame_count = normalized.frame_count
    request.frame_duration_ms = normalized.frame_duration_ms
  }
  return request
}

/** 参考媒体只做确权、不读字节（预检要便宜）；只认经 CLI 上传的参考图。 */
export async function assertReferenceMedia(userId: string, ids: readonly string[]): Promise<void> {
  if (!ids.length) return
  const rows = await db
    .select({ id: schema.media_objects.id })
    .from(schema.media_objects)
    .innerJoin(
      schema.cli_reference_media,
      and(
        eq(schema.cli_reference_media.media_id, schema.media_objects.id),
        eq(schema.cli_reference_media.user_id, userId),
      ),
    )
    .where(
      and(
        inArray(schema.media_objects.id, [...ids]),
        eq(schema.media_objects.user_id, userId),
        eq(schema.media_objects.status, 'ready'),
        like(schema.media_objects.content_type, 'image/%'),
      ),
    )
  const found = new Set(rows.map((row) => row.id))
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length)
    throw new CliRequestError('NOT_FOUND', {
      message: 'reference media not found',
      details: { media_ids: missing },
    })
}

export interface CliQuote {
  readonly estimated_credits: number
}

export interface CliImagePreview {
  readonly quote: CliQuote | null
  readonly planRequired: boolean
}

/** 预检：报价与会员档判断放在同一个只读事务里，不建任务、不预扣。 */
export async function previewImageRequest(
  userId: string,
  prepared: PreparedImageRequest,
  request: SubmitRequest,
): Promise<CliImagePreview> {
  const hooks = (await loadPrivateBffOverlay()).taskHooks
  return db.transaction(async (tx) => {
    const planRequired = !(await strictImageRequestAllowed(
      tx,
      userId,
      prepared.model.provider,
      prepared.model.id,
      request,
    ))
    if (planRequired) return { planRequired, quote: null }
    const quote = await hooks.quoteTask?.({
      tx,
      userId,
      model: prepared.model.id,
      quantity: 1,
      unitMultiplier: imageRateMultiplier(
        prepared.model.id,
        request,
        declaredImageSizes(prepared.model.id),
      ),
    })
    return {
      planRequired,
      quote: quote ? { estimated_credits: quote.estimatedCredits } : null,
    }
  })
}

export interface CliModelCapability {
  readonly id: string
  readonly label: string
  readonly default: boolean
  readonly operations: readonly string[]
  readonly aspect_ratios: readonly string[]
  readonly image_sizes: readonly string[]
  readonly default_image_size: string
  readonly qualities: readonly string[]
  readonly max_reference_images: number
  readonly price: CliQuote | null
  readonly typical_duration_seconds: number | null
  /** `image` 是常规图片；`gif`、`svg` 是模型直出的动图与矢量图，限制见 `gif` / `svg`。 */
  readonly output_formats: readonly CliOutputFormat[]
  readonly gif?: CliGifCapability
  readonly svg?: CliSvgCapability
}

export interface CliGifCapability {
  readonly frame_count: { readonly min: number; readonly max: number; readonly default: number }
  readonly suggested_frame_counts: readonly number[]
  readonly frame_durations_ms: readonly number[]
  readonly default_frame_duration_ms: number
  readonly frame_sizes: readonly string[]
  readonly default_frame_size: string
  readonly max_frames_by_size: Readonly<Record<string, number>>
  readonly reference_images: false
  readonly images_per_request: 1
  readonly price: CliQuote | null
}

export interface CliSvgCapability {
  readonly reference_images: false
  readonly images_per_request: 1
  readonly price: CliQuote | null
}

/** 某个帧尺寸能装下的最多帧数，和网站按拼图上限给的提示一致。 */
function maxFramesFor(size: string): number {
  const [w, h] = size.split('x').map(Number)
  for (let frames = GPT_IMAGE_26_GIF_FRAME_MAX; frames >= GPT_IMAGE_26_GIF_FRAME_MIN; frames--)
    if (!gifSpriteExceedsLimit(w!, h!, frames)) return frames
  return 0
}

async function specialFormatCapabilities(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string,
  model: string,
  hooks: Awaited<ReturnType<typeof loadPrivateBffOverlay>>['taskHooks'],
): Promise<{ gif: CliGifCapability; svg: CliSvgCapability }> {
  const quote = async (request: SubmitRequest) => {
    const one = await hooks.quoteTask?.({
      tx,
      userId,
      model,
      quantity: 1,
      unitMultiplier: imageRateMultiplier(model, request, declaredImageSizes(model)),
    })
    return one ? { estimated_credits: one.estimatedCredits } : null
  }
  return {
    gif: {
      frame_count: {
        min: GPT_IMAGE_26_GIF_FRAME_MIN,
        max: GPT_IMAGE_26_GIF_FRAME_MAX,
        default: GIF_DEFAULT_FRAMES,
      },
      suggested_frame_counts: GPT_IMAGE_26_GIF_FRAMES,
      frame_durations_ms: GPT_IMAGE_26_GIF_DURATIONS_MS,
      default_frame_duration_ms: GPT_IMAGE_26_GIF_DEFAULT_DURATION_MS,
      frame_sizes: GPT_IMAGE_26_GIF_SIZES,
      default_frame_size: GIF_DEFAULT_SIZE,
      max_frames_by_size: Object.fromEntries(
        GPT_IMAGE_26_GIF_SIZES.map((size) => [size, maxFramesFor(size)]),
      ),
      reference_images: false,
      images_per_request: 1,
      price: await quote({
        prompt: '',
        output_format: 'gif',
        frame_count: GIF_DEFAULT_FRAMES,
        size: GIF_DEFAULT_SIZE,
      }),
    },
    svg: {
      reference_images: false,
      images_per_request: 1,
      price: await quote({ prompt: '', output_format: 'svg' }),
    },
  }
}

/**
 * 账号相关的能力清单。非会员的 GPT 列到 2K、不含高画质；4K 与高画质，以及其他模型的 4K，
 * 只对能严格提交的账号列出。直连没开时 GPT 的 2K 兑现不了，清单里也不出现。
 */
export async function imageCapabilities(userId: string) {
  const models = await availableImageModels()
  const hooks = (await loadPrivateBffOverlay()).taskHooks
  return db.transaction(async (tx) => {
    const listed: CliModelCapability[] = []
    for (const model of models) {
      const caps = model.image
      const gpt = isGptDirectModel(model.id)
      const memberTier = await strictImageRequestAllowed(tx, userId, model.provider, model.id, {
        prompt: '',
        ...(gpt ? { size: '3840x2160', quality: 'high' } : { image_size: '4K' }),
      })
      const direct = !gpt || gptDirectConfigured(model.id)
      const tiers = caps.tiers
        .map((tier) => tier.id)
        .filter((id) => {
          if (id === '4K') return memberTier
          if (gpt && id !== '1K') return direct
          return true
        })
      // 该账号一个档位都提交不了的模型不列出，免得被当成默认模型。
      if (tiers.length === 0) continue
      const quote = await hooks.quoteTask?.({
        tx,
        userId,
        model: model.id,
        quantity: 1,
        unitMultiplier: 1,
      })
      listed.push({
        id: model.id,
        label: model.label,
        default: listed.length === 0,
        operations: caps.operations.filter((op) => op !== 'mask_edit'),
        aspect_ratios: [...(caps.autoRatio ? ['auto'] : []), ...caps.surfaces.direct.ratios],
        image_sizes: tiers,
        default_image_size: tiers.includes(caps.defaultTier) ? caps.defaultTier : tiers[0]!,
        qualities: (caps.quality?.values ?? []).filter(
          (quality) => !gpt || memberTier || quality !== 'high',
        ),
        max_reference_images: caps.references.max,
        price: quote ? { estimated_credits: quote.estimatedCredits } : null,
        typical_duration_seconds: model.etaSeconds ?? null,
        output_formats: outputFormatsFor(model.id),
        ...(isGptImage26Model(model.id)
          ? await specialFormatCapabilities(tx, userId, model.id, hooks)
          : {}),
      })
    }
    return {
      default_model: listed[0]?.id ?? null,
      models: listed,
      limits: {
        images_per_request: 1,
        concurrent_jobs: await accountConcurrencyLimit(tx, userId, Date.now()),
        prompt_max_chars: CLI_PROMPT_MAX_CHARS,
      },
    }
  })
}

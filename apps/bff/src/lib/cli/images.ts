import { createHash } from 'node:crypto'
import type { QueueProvider, SubmitRequest } from '@image-playground/shared'
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
import { getDiscoveredChannels, resolveQueueModel } from '../channels'
import { refreshInactiveModels, withoutInactiveModels } from '../model-availability'
import { loadPrivateBffOverlay } from '../private-overlay'
import { premiumRequestAllowed, premiumTierRequested } from '../taskSubmission'
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

export interface CliImageRequestBody {
  readonly prompt: string
  readonly model?: string
  readonly aspect_ratio?: string
  readonly image_size?: string
  readonly quality?: string
  readonly reference_media_ids?: readonly string[]
}

export interface NormalizedImageRequest {
  readonly prompt: string
  readonly model: string
  readonly aspect_ratio: string
  readonly image_size: string
  readonly quality?: string
  readonly reference_media_ids: readonly string[]
  readonly count: 1
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
  const qualities: readonly string[] = caps.quality?.values ?? []
  if (body.quality && !qualities.includes(body.quality))
    throw new CliRequestError('INVALID_REQUEST', {
      message: 'unsupported quality',
      details: { available: qualities },
    })
  const normalized: NormalizedImageRequest = {
    prompt,
    model: model.id,
    aspect_ratio: resolved.ratio,
    image_size: resolved.tier,
    ...(body.quality && body.quality !== 'auto' ? { quality: body.quality } : {}),
    reference_media_ids: references,
    count: 1,
  }
  return {
    normalized,
    requestHash: createHash('sha256').update(canonicalJson(normalized)).digest('hex'),
    adjustments: resolved.adjustments,
    model,
  }
}

/** 规整后的请求 → 队列请求字段，与网站 `queueClient.submit` 的分支保持同一套写法。 */
export function toSubmitRequest(prepared: PreparedImageRequest): SubmitRequest {
  const { normalized, model } = prepared
  const ratio = normalized.aspect_ratio
  const tier = model.image.tiers.find((one) => one.id === normalized.image_size)
  const pixels = ratio === 'auto' ? undefined : tier?.pixels[ratio as keyof typeof tier.pixels]
  const request: SubmitRequest = {
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
  return request
}

/** 参考媒体只做确权，不读字节：预检要便宜，读图留给真正提交。 */
export async function assertReferenceMedia(userId: string, ids: readonly string[]): Promise<void> {
  if (!ids.length) return
  const rows = await db
    .select({ id: schema.media_objects.id })
    .from(schema.media_objects)
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
    const planRequired =
      premiumTierRequested(prepared.model.provider, request) &&
      !(await premiumRequestAllowed(tx, userId, prepared.model.id))
    const quote = await hooks.quoteTask?.({
      tx,
      userId,
      model: prepared.model.id,
      quantity: 1,
      unitMultiplier: 1,
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
}

/** 账号相关的能力清单：价格按这个账号的价目，4K 只对能用的账号列出。 */
export async function imageCapabilities(userId: string) {
  const models = await availableImageModels()
  const hooks = (await loadPrivateBffOverlay()).taskHooks
  return db.transaction(async (tx) => {
    const premium = models.some((model) => model.image.tiers.some((t) => t.id === '4K'))
      ? await premiumRequestAllowed(tx, userId, models[0]!.id)
      : false
    const listed: CliModelCapability[] = []
    for (const [index, model] of models.entries()) {
      const caps = model.image
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
        default: index === 0,
        operations: caps.operations.filter((op) => op !== 'mask_edit'),
        aspect_ratios: [...(caps.autoRatio ? ['auto'] : []), ...caps.surfaces.direct.ratios],
        image_sizes: caps.tiers.map((tier) => tier.id).filter((id) => id !== '4K' || premium),
        default_image_size: caps.defaultTier,
        qualities: caps.quality?.values ?? [],
        max_reference_images: caps.references.max,
        price: quote ? { estimated_credits: quote.estimatedCredits } : null,
        typical_duration_seconds: model.etaSeconds ?? null,
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
      membership_required_for: premium ? [] : ['4K'],
    }
  })
}

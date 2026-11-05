import type { ResultImageMeta } from '@image-playground/shared'
import {
  IMAGE_PRESET_RATIOS,
  IMAGE_SIZE_PRESETS,
  type ImagePresetRatio,
  type QueueProvider,
} from '@image-playground/shared'
import { extractMeta } from '../../extractImages'
import type { HydratedSubmitRequest } from '../../imageArchive'
import { isObject } from '../../type-guards'
import { withoutModeration } from '../openai'
import type { UpstreamCallResult } from '../shared'
import { isResolutionTier } from './catalog'
import { adaptGptRequest } from './gpt-request'
import type {
  AdapterPlan,
  ParsedUpstream,
  PlatformImageRequest,
  ResolutionTier,
  RouteContext,
  Usage,
} from './types'

const ACTUAL_PARAM_KEYS = ['size', 'quality', 'output_format'] as const

function presetSize(
  resolution: 'auto' | ResolutionTier | undefined,
  ratio: string | undefined,
): string | undefined {
  if (!resolution || resolution === 'auto' || !ratio) return undefined
  if (!(IMAGE_PRESET_RATIOS as readonly string[]).includes(ratio)) return undefined
  return IMAGE_SIZE_PRESETS[resolution][ratio as ImagePresetRatio]
}

/** 平台请求 → 队列请求。已有队列请求时不走这条，自定义像素才不会被档位表改写。 */
export function fromPlatform(req: PlatformImageRequest): HydratedSubmitRequest {
  const size = presetSize(req.resolution, req.ratio)
  const extra = { ...(req.extra ?? {}) }
  if (req.background !== undefined && extra.background === undefined) {
    extra.background = req.background
  }
  const imageSize =
    req.resolution && req.resolution !== 'auto' && isResolutionTier(req.resolution)
      ? req.resolution
      : undefined
  return {
    prompt: req.prompt,
    ...(size ? { size } : {}),
    ...(imageSize ? { image_size: imageSize } : {}),
    ...(req.ratio ? { aspect_ratio: req.ratio } : {}),
    ...(req.count > 0 ? { n: req.count } : {}),
    ...(req.references?.length ? { input_images: req.references } : {}),
    ...(req.mask ? { mask: req.mask } : {}),
    ...(req.format ? { output_format: req.format } : {}),
    ...(req.compression != null ? { output_compression: req.compression } : {}),
    ...(req.quality ? { quality: req.quality } : {}),
    ...(req.moderation ? { moderation: req.moderation } : {}),
    ...(req.thinking ? { thinking_level: req.thinking } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  }
}

/**
 * 调度层传来的队列请求已经按通道适配过，原样使用。
 * 再跑一次直连适配会多剥一层防改写前缀。平台请求只在直接调用 plan 时重建。
 */
export function workingRequest(
  req: PlatformImageRequest,
  model: string,
  ctx: RouteContext,
): HydratedSubmitRequest {
  if (ctx.request) return ctx.request
  let request = fromPlatform(req)
  if (ctx.gptRoute) request = adaptGptRequest(ctx.gptRoute, model, request)
  if (ctx.forceB64Json) {
    request = { ...request, extra: { ...request.extra, response_format: 'b64_json' } }
  }
  if (ctx.supportsModeration === false) request = withoutModeration(request)
  return request
}

export function echoedActualParams(payload: unknown): Record<string, string> {
  if (!isObject(payload)) return {}
  const out: Record<string, string> = {}
  for (const key of ACTUAL_PARAM_KEYS) {
    const value = payload[key]
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/**
 * 合并之后补上生效参数。上游自己回了 size / quality / output_format 时保留回执，
 * 缺的才用计划里真正发出去的值补上，避免 fan-out 把 actual_params 弄丢。
 */
export function stampReceipt(result: UpstreamCallResult, plan: AdapterPlan): UpstreamCallResult {
  if (!isObject(result.payload)) return result
  const filled: Record<string, string> = {}
  for (const key of ACTUAL_PARAM_KEYS) {
    if (typeof result.payload[key] === 'string') continue
    const value = plan.applied[key]
    if (typeof value === 'string') filled[key] = value
  }
  return {
    payload: {
      ...result.payload,
      ...filled,
      applied: plan.applied,
      dropped: plan.dropped,
    },
  }
}

function readUsage(payload: unknown): Usage | undefined {
  if (!isObject(payload) || !isObject(payload.usage)) return undefined
  const usage = payload.usage
  if (typeof usage.output_tokens !== 'number') return undefined
  const details = isObject(usage.input_tokens_details) ? usage.input_tokens_details : undefined
  return {
    ...(typeof usage.input_tokens === 'number' ? { input_tokens: usage.input_tokens } : {}),
    output_tokens: usage.output_tokens,
    ...(details
      ? {
          input_tokens_details: {
            ...(typeof details.image_tokens === 'number'
              ? { image_tokens: details.image_tokens }
              : {}),
            ...(typeof details.text_tokens === 'number'
              ? { text_tokens: details.text_tokens }
              : {}),
          },
        }
      : {}),
  }
}

function toParsedImage(image: ResultImageMeta): ParsedUpstream['images'][number] {
  return {
    index: image.index,
    mime: image.mime,
    ...(image.revised_prompt ? { revised_prompt: image.revised_prompt } : {}),
    ...(image.duration_seconds !== undefined ? { duration_seconds: image.duration_seconds } : {}),
  }
}

export function parsePayload(provider: QueueProvider, payload: unknown): ParsedUpstream {
  const meta = extractMeta(provider, payload)
  const usage = readUsage(payload)
  return {
    images: meta.images.map(toParsedImage),
    ...(usage ? { usage } : {}),
    payload,
  }
}

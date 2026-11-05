import { isGptDirectModel } from '@image-playground/shared'
import type { HydratedSubmitRequest } from '../../imageArchive'
import {
  buildOpenAIBody,
  buildOpenAIEditFormData,
  mergeOpenAIImageResults,
  withoutImageCount,
} from '../openai'
import type { UpstreamCallResult } from '../shared'
import { catalogCapabilities } from './catalog'
import { parsePayload, workingRequest } from './platform'
import type {
  AdapterPlan,
  ImageAdapter,
  PlatformImageRequest,
  RouteContext,
  UpstreamCall,
} from './types'

const SUB2API_DROPS_SIZE = 'sub2api 不兑现 size，构图只写在提示词里'
const SUB2API_DROPS_QUALITY = 'sub2api 不兑现 quality，不把它记成生效画质'

function countOf(request: HydratedSubmitRequest, fallback: number): number {
  return Math.max(1, request.n ?? fallback ?? 1)
}

function appliedScalars(
  request: HydratedSubmitRequest,
  honorsSize: boolean,
  honorsQuality: boolean,
): Record<string, unknown> {
  return {
    ...(honorsSize && request.size ? { size: request.size } : {}),
    ...(honorsQuality && request.quality ? { quality: request.quality } : {}),
    ...(request.output_format ? { output_format: request.output_format } : {}),
    ...(request.moderation ? { moderation: request.moderation } : {}),
    n: countOf(request, 1),
  }
}

function planImages(
  kind: 'direct' | 'sub2api',
  req: PlatformImageRequest,
  model: string,
  ctx: RouteContext,
): AdapterPlan {
  const request = workingRequest(req, model, { ...ctx, gptRoute: ctx.gptRoute ?? kind })
  const editing = Boolean(request.input_images?.length || request.mask)
  const count = countOf(request, req.count)
  const native = kind === 'direct' && ctx.supportsNativeN === true && !editing && count > 1
  const honorsSize = kind === 'direct'
  const honorsQuality = kind === 'direct'
  const dropped: AdapterPlan['dropped'] = []
  // 直连模型走 sub2api 时上游会丢掉 size 和 quality。请求体仍带上它们：网关忽略，线协议保持原样。
  if (!honorsSize && isGptDirectModel(model) && request.size) {
    dropped.push({ param: 'size', reason: SUB2API_DROPS_SIZE })
  }
  if (!honorsQuality && request.quality) {
    dropped.push({ param: 'quality', reason: SUB2API_DROPS_QUALITY })
  }
  const applied = appliedScalars(request, honorsSize, honorsQuality)

  if (editing) {
    const unit = count === 1 ? request : withoutImageCount(request)
    // multipart 体按需构造：派发走 freshBody，这里不预先解码 count 份参考图占着内存。
    const makeCall = (): UpstreamCall => ({
      method: 'POST',
      path: '/images/edits',
      get body() {
        return buildOpenAIEditFormData(model, unit)
      },
      multipart: true,
      images: 1,
    })
    return {
      calls: Array.from({ length: count }, makeCall),
      applied,
      dropped,
      freshBody: () => buildOpenAIEditFormData(model, unit),
    }
  }

  const unit = native || count === 1 ? request : withoutImageCount(request)
  const body = buildOpenAIBody(model, unit)
  const images = native ? count : 1
  const calls =
    native || count === 1
      ? [{ method: 'POST' as const, path: '/images/generations', body, images }]
      : Array.from({ length: count }, () => ({
          method: 'POST' as const,
          path: '/images/generations',
          body,
          images: 1,
        }))
  return { calls, applied, dropped, freshBody: () => body }
}

function capabilities(kind: 'direct' | 'sub2api', model: string) {
  return catalogCapabilities(model, {
    honorsSize: kind === 'direct',
    promptGuard: kind === 'direct' ? 'none' : 'prefix',
    nativeCount: { generate: kind === 'direct', edit: false },
    background: true,
    moderation: true,
  })
}

function parse(results: UpstreamCallResult[]) {
  const payload =
    results.length <= 1 ? results[0]?.payload : mergeOpenAIImageResults(results).payload
  return parsePayload('openai-compat', payload)
}

/** OpenAI 直连：文生图原生 n，改图逐张 fan-out，认 size。 */
export const openaiImagesDirect: ImageAdapter = {
  protocol: 'openai-images',
  capabilities: (model) => capabilities('direct', model),
  plan: (req, model, ctx) => planImages('direct', req, model, ctx),
  parse,
}

/** 通用网关 / sub2api：不兑现直连模型的 size，逐张 fan-out。 */
export const openaiImagesSub2api: ImageAdapter = {
  protocol: 'openai-images',
  capabilities: (model) => capabilities('sub2api', model),
  plan: (req, model, ctx) => planImages('sub2api', req, model, ctx),
  parse,
}

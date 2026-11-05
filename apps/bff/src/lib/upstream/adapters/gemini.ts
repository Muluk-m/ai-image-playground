import { isObject } from '../../type-guards'
import { buildGeminiBody, mergeGeminiCandidateResults } from '../gemini'
import type { UpstreamCallResult } from '../shared'
import { buildVertexBody } from '../vertex'
import { catalogCapabilities, isResolutionTier } from './catalog'
import { parsePayload, workingRequest } from './platform'
import type { DroppedParam, ImageAdapter, ResolutionTier } from './types'

/**
 * 渠道目前不开放 4K（还没按档计价）。目录里的 4K 仍标成会员档，
 * 真正放开发请求是 PR-D 的事，这里只记录降档。
 */
function openTiers(model: string): ResolutionTier[] {
  return catalogCapabilities(model, {
    honorsSize: true,
    promptGuard: 'none',
    nativeCount: { generate: false, edit: false },
  }).tiers.filter((tier) => tier !== '4K')
}

function imageConfigOf(body: Record<string, unknown>): {
  imageSize?: string
  aspectRatio?: string
} {
  if (!isObject(body.generationConfig) || !isObject(body.generationConfig.imageConfig)) return {}
  const imageConfig = body.generationConfig.imageConfig
  return {
    ...(typeof imageConfig.imageSize === 'string' ? { imageSize: imageConfig.imageSize } : {}),
    ...(typeof imageConfig.aspectRatio === 'string'
      ? { aspectRatio: imageConfig.aspectRatio }
      : {}),
  }
}

export const geminiAdapter: ImageAdapter = {
  protocol: 'gemini-generate-content',
  capabilities: (model) => {
    const base = catalogCapabilities(model, {
      honorsSize: true,
      promptGuard: 'none',
      nativeCount: { generate: false, edit: false },
      formats: ['png'],
    })
    return { ...base, tiers: openTiers(model) }
  },
  plan: (req, model, ctx) => {
    const request = workingRequest(req, model, ctx)
    const body = ctx.vertex
      ? buildVertexBody(request, ctx.imageSizes)
      : buildGeminiBody(request, ctx.imageSizes)
    const sent = imageConfigOf(body)
    const extraConfig = request.extra?.generationConfig
    const requested = isObject(extraConfig) && isObject(extraConfig.imageConfig)
      ? extraConfig.imageConfig.imageSize
      : request.image_size
    const dropped: DroppedParam[] = []
    // 只在请求体真的被收成另一档时记降档。
    if (typeof requested === 'string' && sent.imageSize && requested !== sent.imageSize) {
      dropped.push({
        param: 'image_size',
        reason: isResolutionTier(requested)
          ? `模型未开放 ${requested}，已降到 ${sent.imageSize}`
          : `不支持的分辨率 ${requested} 已降到 ${sent.imageSize}`,
      })
    }
    const count = Math.max(1, request.n ?? req.count ?? 1)
    const path = `/models/${encodeURIComponent(model)}:generateContent`
    const call = { method: 'POST' as const, path, body, images: 1 }
    return {
      calls: Array.from({ length: count }, () => call),
      applied: {
        ...(sent.imageSize ? { image_size: sent.imageSize } : {}),
        ...(sent.aspectRatio ? { aspect_ratio: sent.aspectRatio } : {}),
        ...(request.thinking_level ? { thinking_level: request.thinking_level } : {}),
        n: count,
      },
      dropped,
      freshBody: () => body,
    }
  },
  parse: (results: UpstreamCallResult[]) => {
    const payload =
      results.length <= 1 ? results[0]?.payload : mergeGeminiCandidateResults(results).payload
    return parsePayload('gemini', payload)
  },
}

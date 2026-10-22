import type { HydratedSubmitRequest } from '../imageArchive'
import { clientError } from './shared'

/*
 * Vertex AI（Agent Platform）直连 Gemini 图像模型的兼容性收口。请求体与网关 Gemini 是同一份
 * generateContent（`buildGeminiBody`），这里只处理上游实测会 400 的参数组合，别把它扩成字段翻译。
 *
 * 2026-10-22 在 global 端点实测：
 * - gemini-3.1-flash-lite-image 只出 1K，带 imageSize 2K / 512 一律 400 invalid argument；
 * - gemini-nano-banana-2.1 与 gemini-3-pro-image 认 1K / 2K（及 4K），512 一律 400；
 * - 三者都认 thinkingLevel minimal / high。
 */

/**
 * 每个模型认的分辨率档位；不在表里的模型不收口，原样透传。`channels.json` 的 vertex-images
 * 每加一个模型都要在这里登记，`upstream-vertex.test.ts` 核对两边的模型清单一致。
 */
export const VERTEX_IMAGE_SIZES: Readonly<Record<string, readonly string[]>> = {
  'gemini-3.1-flash-lite-image': ['1K'],
  'gemini-nano-banana-2.1': ['1K', '2K', '4K'],
  'gemini-3-pro-image': ['1K', '2K', '4K'],
}

/** Gemini 3 系图像模型单次最多 14 张参考图（官方上限）；超出时上游 400，提交前就拦下并说清楚。 */
export const VERTEX_MAX_INPUT_IMAGES = 14

export function normalizeVertexRequest(
  model: string,
  request: HydratedSubmitRequest,
): HydratedSubmitRequest {
  if ((request.input_images?.length ?? 0) > VERTEX_MAX_INPUT_IMAGES)
    throw clientError(`该模型最多接受 ${VERTEX_MAX_INPUT_IMAGES} 张参考图，请减少参考图后重试`)
  const sizes = Object.hasOwn(VERTEX_IMAGE_SIZES, model) ? VERTEX_IMAGE_SIZES[model] : undefined
  if (!sizes) return request
  // buildGeminiBody 让 extra.generationConfig 最后压过扁平参数，所以真正发出去的是 extra 里的
  // imageSize（若有）；两处都要按同一张表收口，否则 extra 能绕过这里把 400 组合原样送上游。
  const extra = request.extra as
    | { generationConfig?: { imageConfig?: Record<string, unknown> } & Record<string, unknown> }
    | undefined
  const extraImageConfig = extra?.generationConfig?.imageConfig
  const extraSize = extraImageConfig?.imageSize
  const flatSize = normalizeVertexSize(sizes, request.image_size)
  const effectiveExtraSize =
    typeof extraSize === 'string' ? normalizeVertexSize(sizes, extraSize) : extraSize
  if (flatSize === request.image_size && effectiveExtraSize === extraSize) return request
  const next: HydratedSubmitRequest = { ...request, image_size: flatSize }
  if (effectiveExtraSize !== extraSize && extra?.generationConfig && extraImageConfig) {
    next.extra = {
      ...extra,
      generationConfig: {
        ...extra.generationConfig,
        imageConfig: { ...extraImageConfig, imageSize: effectiveExtraSize },
      },
    }
  }
  return next
}

function normalizeVertexSize<T extends string | undefined>(sizes: readonly string[], size: T): T {
  if (!size || sizes.includes(size)) return size
  // 512 比最低档还小：升到 1K 只会更清楚，计费按张不变，不值得让整单失败。
  if (size === '512' && sizes.includes('1K')) return '1K' as T
  throw clientError(`该模型只支持 ${sizes.join(' / ')} 分辨率，请改为其中一档或选「自动」`)
}

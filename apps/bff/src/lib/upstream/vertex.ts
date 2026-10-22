import type { HydratedSubmitRequest } from '../imageArchive'
import { buildGeminiBody } from './gemini'
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

/**
 * 构造发往 Vertex 的 generateContent 请求体，并在发出前拦下实测会 400 的组合。
 *
 * 校验的是 `buildGeminiBody` 产出的最终 `generationConfig.imageConfig`，而不是扁平的
 * `image_size`：`extra.generationConfig` 会整段压过扁平参数推导的配置，只有最终值才是上游真正
 * 收到的。显式给了却不是对象的 imageConfig、不是字符串的 imageSize 一律当无效拒绝。
 *
 * 唯一的改写是 512 → 1K：共享的 Gemini 分辨率档位（`GEMINI_IMAGE_SIZES`）里有 512，作图面板、
 * Agent 批量计划、制作编辑器都会给 Vertex 模型提供这一档，已存的旧任务重试也会带着它。1K 是更高
 * 一档、计费按张不变，升档比整单失败好；任务里记的仍是用户选的 512，这是有意的兼容取舍。
 */
export function buildVertexBody(
  model: string,
  request: HydratedSubmitRequest,
): Record<string, unknown> {
  if ((request.input_images?.length ?? 0) > VERTEX_MAX_INPUT_IMAGES)
    throw clientError(`该模型最多接受 ${VERTEX_MAX_INPUT_IMAGES} 张参考图，请减少参考图后重试`)
  const body = buildGeminiBody(request)
  const sizes = Object.hasOwn(VERTEX_IMAGE_SIZES, model) ? VERTEX_IMAGE_SIZES[model] : undefined
  if (!sizes) return body
  const generationConfig = body.generationConfig as Record<string, unknown>
  const imageConfig = generationConfig.imageConfig
  if (imageConfig === undefined) return body
  if (imageConfig === null || typeof imageConfig !== 'object' || Array.isArray(imageConfig))
    throw clientError('分辨率配置无效，请改用面板里的分辨率选项后重试')
  const size = (imageConfig as { imageSize?: unknown }).imageSize
  if (size === undefined || (typeof size === 'string' && sizes.includes(size))) return body
  if (size === '512' && sizes.includes('1K')) {
    return {
      ...body,
      generationConfig: { ...generationConfig, imageConfig: { ...imageConfig, imageSize: '1K' } },
    }
  }
  throw clientError(`该模型只支持 ${sizes.join(' / ')} 分辨率，请改为其中一档或选「自动」`)
}

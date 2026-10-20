import type { AgentTurnParams, QueueProvider, SubmitRequest } from '@image-playground/shared'
import {
  AGENT_IMAGE_MAX_N,
  IMAGE_PRESET_RATIOS,
  type ImagePresetRatio,
  nearestAspectRatio,
  requestedImageCount,
  sizeForAspectRatio,
} from '@image-playground/shared'
import { Type } from 'typebox'

export const imageCountParameter = Type.Optional(
  Type.Integer({
    minimum: 1,
    maximum: AGENT_IMAGE_MAX_N,
    description:
      '同一提示词生成的张数或版本数。只有用户在这句话里明确说了张数才填；省略时沿用用户在输入框选择的张数。不同画面或修改方案请分别调用。',
  }),
)

export const aspectRatioParameter = Type.Optional(
  Type.Union(
    IMAGE_PRESET_RATIOS.map((ratio) => Type.Literal(ratio)),
    {
      description:
        '画面比例。只有用户这次明确说了比例或用途（如 16:9、横版、竖版海报、手机竖屏、方图）才填；省略时沿用用户在输入框选择的尺寸。清晰度档位保持用户的选择。工具回执会写明实际尺寸，向用户说比例时以回执为准。',
    },
  ),
)

/**
 * 模型按用户原话指定的比例覆盖轮参数里的尺寸，档位不变。没有这一项时，模型承诺的比例
 * 根本送不到上游（2026-10-13 会话 1808d8cf：说好 16:9，实际出 1024x1024）。
 */
export function withAspectRatio(
  params: AgentTurnParams | undefined,
  ratio: ImagePresetRatio | undefined,
): AgentTurnParams | undefined {
  if (!ratio) return params
  // gemini 优先读输入框里的 aspectRatio，不去掉它，模型指定的比例在 gemini 上不生效。
  const { gemini_aspect_ratio: _chosen, ...rest } = params ?? {}
  return { ...rest, size: sizeForAspectRatio(params?.size, ratio) }
}

/** 工具显式张数优先，否则沿用用户本轮选择的张数。 */
export { requestedImageCount }

/** 提交生成任务的工具共用：成功后要不要被唤醒回来复核。失败一律唤醒，不归它管。 */
export const reviewParameter = Type.Optional(
  Type.Boolean({
    description:
      '成功后是否唤醒你回来复核结果；需要你检查效果再汇报时设为 true，普通出图不需要。失败总会唤醒你。',
  }),
)

/**
 * 这次图片工具调用出几张。`toolStart` 早于 pi 的参数校验，所以走 shared 里与
 * `Value.Convert` 同语义的那一份——画布占位与队列请求共用它，两处才不会各算各的。
 */
export { agentImageCount } from '@image-playground/shared'

/**
 * 轮上的生成参数 → 队列请求字段。
 *
 * 分支必须与 web 的 `lib/channels/queueClient.ts` 里 `submit()` 那段保持一致：同一组参数
 * 走直接生成和走智能体，发给上游的东西必须是同一份，否则用户改了比例却只有一条路生效。
 * `auto` 在这里等于「没选」——上游认不得这个字面量，带上去反而是个坏值。
 * `moderation` 不在这里补：`createQueueTask` 对每一条 openai 系图片任务都会兜底成
 * `DEFAULT_IMAGE_MODERATION`，两条路共用那一处，这里再写一遍就是第二份实现。
 */
export function queueParamsFor(
  provider: QueueProvider,
  params: AgentTurnParams | undefined,
): Partial<SubmitRequest> {
  const mapped: Partial<SubmitRequest> = {}
  if (!params) return mapped

  if (params.size && params.size !== 'auto') mapped.size = params.size
  if (params.quality && params.quality !== 'auto') mapped.quality = params.quality

  if (provider === 'openai-compat') {
    if (params.output_format) mapped.output_format = params.output_format
    // 压缩率只对有损格式成立，png 带上它上游会拒。
    if (
      params.output_format &&
      params.output_format !== 'png' &&
      params.output_compression != null
    ) {
      mapped.output_compression = params.output_compression
    }
  } else if (provider === 'gemini') {
    const aspectRatio =
      params.gemini_aspect_ratio ?? (params.size ? nearestAspectRatio(params.size) : undefined)
    if (aspectRatio) mapped.aspect_ratio = aspectRatio
    if (params.gemini_image_size) mapped.image_size = params.gemini_image_size
    if (params.gemini_thinking_level) mapped.thinking_level = params.gemini_thinking_level
  }
  return mapped
}

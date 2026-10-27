import type { AgentTurnParams } from './agent'
import {
  formatImageRatio,
  IMAGE_PRESET_RATIOS,
  type ImagePresetRatio,
  nearestAspectRatio,
  parseImageSize,
  sizeForAspectRatio,
} from './image'

/**
 * 模型按用户原话指定的比例覆盖轮参数里的尺寸，档位不变。没有这一项时，模型承诺的比例
 * 根本送不到上游（2026-10-13 会话 1808d8cf：说好 16:9，实际出 1024x1024）。
 *
 * gemini 优先读输入框里的 aspectRatio，所以要把它去掉，否则模型指定的比例在 gemini 上不生效。
 * 智能体单张工具、批次计划项、结果卡与计划卡的展示都经过这里，几处才说同一个比例。
 */
export function withAspectRatio(
  params: AgentTurnParams | undefined,
  ratio: ImagePresetRatio | undefined,
): AgentTurnParams | undefined {
  if (!ratio) return params
  const { gemini_aspect_ratio: _chosen, ...rest } = params ?? {}
  return { ...rest, size: sizeForAspectRatio(params?.size, ratio) }
}

/** 工具参数里的 `aspectRatio`；不是预设档位的值不算数，与工具 schema 的校验一致。 */
export function presetAspectRatio(value: unknown): ImagePresetRatio | undefined {
  return typeof value === 'string' && (IMAGE_PRESET_RATIOS as readonly string[]).includes(value)
    ? (value as ImagePresetRatio)
    : undefined
}

/** `1280x720` → `16:9`；认不出或 `auto` 时没有比例。标签与界面其它地方同取 `formatImageRatio`。 */
export function sizeRatio(size: string | undefined): string | undefined {
  const parsed = size && size !== 'auto' ? parseImageSize(size) : null
  return (parsed && formatImageRatio(parsed.width, parsed.height)) || undefined
}

/** 一次图片提交在上游实际生效的画幅。字段缺席即上游按自己的默认来，界面不该替它编一个。 */
export interface AgentImageShape {
  /** openai 系的 `宽x高`；gemini 不收 size。 */
  readonly size?: string
  /** gemini 的清晰度档位（1K / 2K / 4K）。 */
  readonly imageSize?: string
  readonly aspectRatio?: string
}

/**
 * 轮参数（已叠加工具比例）在某个供应商上实际生效的画幅。
 *
 * 与 bff `queueParamsFor` 同一套规则：openai 系只认 size，gemini 只认 aspect_ratio 与
 * image_size。展示必须照这个来——openai 任务上显示 `gemini_aspect_ratio` 就是把用户的全局
 * 设置当成了这次的结果（BUG-20 / BUG-30：卡上写 9:16，图其实是 16:9 或 1:1）。
 */
export function agentImageShape(
  provider: string | undefined,
  params: AgentTurnParams | undefined,
): AgentImageShape {
  const size = params?.size && params.size !== 'auto' ? params.size : undefined
  if (provider === 'gemini') {
    const aspectRatio = params?.gemini_aspect_ratio ?? (size ? nearestAspectRatio(size) : undefined)
    return {
      ...(params?.gemini_image_size ? { imageSize: params.gemini_image_size } : {}),
      ...(aspectRatio ? { aspectRatio } : {}),
    }
  }
  const aspectRatio = sizeRatio(size)
  return { ...(size ? { size } : {}), ...(aspectRatio ? { aspectRatio } : {}) }
}

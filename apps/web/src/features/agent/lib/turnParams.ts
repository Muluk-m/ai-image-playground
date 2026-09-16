import type { AgentTurnParams } from '@image-playground/shared'
import type { TaskParams } from '../../../types'
import { DEFAULT_PARAMS } from '../../../types'

/**
 * 工作台的参数 chip → 起轮请求里的生成参数。
 *
 * 只带用户真正改过的项：服务端缺席即按部署默认，送一份全是默认值的对象等于把
 * 前端的默认值强加给后端，两边改默认值的节奏就再也对不上了。
 * 张数由工具参数决定，审核使用上游默认；不继承直接生成或旧版本留下的选择。
 *
 * **透明输出与防改写不在这里**，不是漏了：
 * - 透明是往提示词注绿幕再在本地抠色（`lib/transparentImage.ts`），整条流水线在浏览器里；
 * - 防改写是给提示词加前缀（`lib/imageApiShared.ts` 的 guard），而智能体的提示词由模型
 *   在服务端写，前端碰不到。
 *
 * 两者都要服务端补齐能力才能给智能体用，在那之前参数浮层里也不该出现它们——
 * 显示了却不生效比没有更糟。
 */
export function toAgentTurnParams(
  params: TaskParams,
  model: string | undefined,
): AgentTurnParams | undefined {
  const next: Record<string, unknown> = {}
  if (model) next.model = model
  if (params.size !== DEFAULT_PARAMS.size) next.size = params.size
  if (params.quality !== DEFAULT_PARAMS.quality) next.quality = params.quality
  if (params.output_format !== DEFAULT_PARAMS.output_format) {
    next.output_format = params.output_format
  }
  if (
    params.output_compression != null &&
    params.output_compression !== DEFAULT_PARAMS.output_compression
  ) {
    next.output_compression = params.output_compression
  }
  if (params.gemini_aspect_ratio) next.gemini_aspect_ratio = params.gemini_aspect_ratio
  if (params.gemini_image_size) next.gemini_image_size = params.gemini_image_size
  if (params.gemini_thinking_level) next.gemini_thinking_level = params.gemini_thinking_level

  return Object.keys(next).length > 0 ? (next as AgentTurnParams) : undefined
}

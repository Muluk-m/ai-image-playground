import { AGENT_IMAGE_MAX_N, type AgentTurnParams } from '@image-playground/shared'
import type { TaskParams } from '../../../types'
import { DEFAULT_PARAMS } from '../../../types'

/** 图片生成模式的张数档。智能体模式不把张数交给用户。 */
export const IMAGE_COUNT_CHOICES = [1, 2, 3, 4, 6, 8] as const

/** 旧步进器留下的 5、7、9、10 收到最近的一档；距离相同取较小的那档。 */
export function snapImageCount(n: number): number {
  const value = Math.trunc(n)
  if (!Number.isFinite(value)) return 1
  let best: number = IMAGE_COUNT_CHOICES[0]
  for (const choice of IMAGE_COUNT_CHOICES) {
    const distance = Math.abs(choice - value)
    const bestDistance = Math.abs(best - value)
    if (distance < bestDistance || (distance === bestDistance && choice < best)) best = choice
  }
  return best
}

/**
 * 工作台的参数 chip → 起轮请求里的生成参数。
 *
 * 只带用户真正改过的项：服务端缺席即按部署默认，送一份全是默认值的对象等于把
 * 前端的默认值强加给后端，两边改默认值的节奏就再也对不上了。
 * 智能体模式不送张数，由模型按需求决定；图片生成模式才带上用户选的那一档。
 * 审核强度没有 chip，由服务端建任务时统一兜底（`taskSubmission.ts`），两条路同一处。
 *
 * **透明输出不在这里**，不是漏了：它是往提示词注绿幕再在本地抠色（`lib/transparentImage.ts`），
 * 整条流水线在浏览器里，服务端补齐能力之前给不了智能体。防改写 guard 与「模型丢 size 时的
 * 构图指令」已经下沉到服务端（`packages/shared/src/prompt-shaping.ts`，智能体侧在
 * `apps/bff/src/lib/agent/prompt-shaping.ts` 提交那一刻施加），所以也不必在这里传。
 *
 * 参数浮层里不该出现做不到的开关——显示了却不生效比没有更糟。
 */
export function toAgentTurnParams(
  params: TaskParams,
  model: string | undefined,
  autoSubmit: boolean,
  options?: { readonly includeCount?: boolean },
): AgentTurnParams | undefined {
  const next: Record<string, unknown> = {}
  if (model) next.model = model
  // 画布缺这个字段会按直接出图处理，所以关掉时必须显式送 false。
  next.autoSubmit = autoSubmit
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
  if (options?.includeCount) {
    const count = snapImageCount(params.n)
    if (count >= 1 && count <= AGENT_IMAGE_MAX_N && count !== DEFAULT_PARAMS.n) next.n = count
  }

  return Object.keys(next).length > 0 ? (next as AgentTurnParams) : undefined
}

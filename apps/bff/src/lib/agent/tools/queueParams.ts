import type { AgentTurnParams, QueueProvider, SubmitRequest } from '@image-playground/shared'
import { AGENT_TURN_MAX_N, nearestAspectRatio } from '@image-playground/shared'

/**
 * 轮上的生成参数 → 队列请求字段。
 *
 * 分支必须与 web 的 `lib/channels/queueClient.ts` 里 `submit()` 那段保持一致：同一组参数
 * 走直接生成和走智能体，发给上游的东西必须是同一份，否则用户改了比例却只有一条路生效。
 * `auto` 在这里等于「没选」——上游认不得这个字面量，带上去反而是个坏值。
 */
export function queueParamsFor(
  provider: QueueProvider,
  params: AgentTurnParams | undefined,
): Partial<SubmitRequest> {
  const mapped: Partial<SubmitRequest> = {
    n: Math.min(AGENT_TURN_MAX_N, Math.max(1, params?.n ?? 1)),
  }
  if (!params) return mapped

  if (params.size && params.size !== 'auto') mapped.size = params.size
  if (params.quality && params.quality !== 'auto') mapped.quality = params.quality

  if (provider === 'openai-compat') {
    if (params.output_format) mapped.output_format = params.output_format
    if (params.moderation) mapped.moderation = params.moderation
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

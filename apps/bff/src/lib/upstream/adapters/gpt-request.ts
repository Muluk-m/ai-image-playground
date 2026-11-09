import { isGptDirectModel, wirePrompt } from '@image-playground/shared'
import type { HydratedSubmitRequest } from '../../imageArchive'

/** 每次实际选路后从原始请求适配，换路时不沿用上一条路加过的机器指令。 */
export function adaptGptRequest(
  route: 'direct' | 'sub2api',
  model: string,
  request: HydratedSubmitRequest,
): HydratedSubmitRequest {
  const prompt = wirePrompt({
    prompt: request.prompt,
    route,
    facts: {
      provider: 'openai-compat',
      model,
      ...(request.size ? { size: request.size } : {}),
      no_rewrite: request.no_rewrite,
      ratio_via_prompt: isGptDirectModel(model),
    },
  })
  if (route === 'direct') {
    // 2.5 的 auto 仍按 medium 控制成本；2.6 沿用自己的画质契约。
    const quality =
      isGptDirectModel(model) && (!request.quality || request.quality === 'auto')
        ? 'medium'
        : request.quality
    return { ...request, prompt, ...(quality ? { quality } : {}) }
  }
  return { ...request, prompt }
}

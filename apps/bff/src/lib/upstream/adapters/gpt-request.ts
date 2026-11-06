import {
  applyPromptRewriteGuard,
  buildAspectInstruction,
  isGptDirectModel,
  isGptImage26Model,
  unshapeQueuePrompt,
} from '@image-playground/shared'
import type { HydratedSubmitRequest } from '../../imageArchive'

/** 每次实际选路后从原始请求适配，换路时不沿用上一条路加过的机器指令。 */
export function adaptGptRequest(
  route: 'direct' | 'sub2api',
  model: string,
  request: HydratedSubmitRequest,
): HydratedSubmitRequest {
  if (isGptImage26Model(model)) {
    const prompt = unshapeQueuePrompt({
      provider: 'openai-compat',
      prompt: request.prompt,
      stripRewriteGuard: request.no_rewrite === undefined,
    })
    const animated = request.output_format === 'gif' || request.output_format === 'svg'
    const quality =
      animated || !request.quality || request.quality === 'auto' ? 'medium' : request.quality
    return {
      ...request,
      prompt,
      quality,
      ...(animated ? { n: 1, output_compression: undefined } : {}),
      ...(request.output_format === 'gif'
        ? { frame_duration_ms: request.frame_duration_ms ?? 200 }
        : {}),
    }
  }
  if (route === 'direct') {
    const prompt = unshapeQueuePrompt({
      provider: 'openai-compat',
      prompt: request.prompt,
      size: isGptDirectModel(model) ? request.size : undefined,
      stripRewriteGuard: request.no_rewrite === undefined,
    })
    // 2.5 的 auto 仍按 medium 控制成本；2.6 沿用自己的画质契约。
    const quality =
      isGptDirectModel(model) && (!request.quality || request.quality === 'auto')
        ? 'medium'
        : request.quality
    return { ...request, prompt, ...(quality ? { quality } : {}) }
  }
  let prompt = request.prompt
  // 旧客户端已经带过前缀；新客户端用参数表达意图，用户原文里同样的文字也不吞掉。
  if (request.no_rewrite === true) prompt = applyPromptRewriteGuard(prompt)
  const instruction =
    isGptDirectModel(model) && request.size ? buildAspectInstruction(request.size) : null
  if (instruction && !prompt.endsWith(instruction)) prompt = `${prompt}\n\n${instruction}`
  return { ...request, prompt }
}

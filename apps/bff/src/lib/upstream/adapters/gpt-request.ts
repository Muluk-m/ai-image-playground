import {
  buildAspectInstruction,
  isGptDirectModel,
  unshapeQueuePrompt,
} from '@image-playground/shared'
import type { HydratedSubmitRequest } from '../../imageArchive'

/**
 * 同一单按通道改参数。sub2api（Codex 图片路径）丢弃 size 与 quality，只认提示词里写明的构图，
 * 所以补上构图句；直连认原生参数，把提交时钉上的机器指令（防改写前缀、构图句）剥掉，auto 画质
 * 改发 medium（auto 可能出高画质，成本没有上限，计价也按 medium）。
 *
 * 只跑一次。直连会剥掉一层防改写前缀；再跑一次会把用户原文里自带的前缀也剥掉。
 */
export function adaptGptRequest(
  route: 'direct' | 'sub2api',
  model: string,
  request: HydratedSubmitRequest,
): HydratedSubmitRequest {
  if (!isGptDirectModel(model)) return request
  if (route === 'direct') {
    const prompt = unshapeQueuePrompt({
      provider: 'openai-compat',
      prompt: request.prompt,
      ...(request.size ? { size: request.size } : {}),
    })
    const quality = !request.quality || request.quality === 'auto' ? 'medium' : request.quality
    return { ...request, prompt, quality }
  }
  const instruction = request.size ? buildAspectInstruction(request.size) : null
  if (!instruction || request.prompt.endsWith(instruction)) return request
  return { ...request, prompt: `${request.prompt}\n\n${instruction}` }
}

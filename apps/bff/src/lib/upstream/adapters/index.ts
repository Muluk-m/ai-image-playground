import { isGptDirectModel, type QueueProvider } from '@image-playground/shared'
import { findCatalogModel } from '@image-playground/shared/model-catalog'
import type { HydratedSubmitRequest } from '../../imageArchive'
import type { ChannelRouteStyle } from '../shared'
import { agnesAdapter } from './agnes'
import { geminiAdapter } from './gemini'
import { grokAdapter } from './grok'
import { openaiImagesDirect, openaiImagesSub2api } from './openai-images'
import { openaiResponsesAdapter } from './openai-responses'
import type {
  AdapterCapabilities,
  AdapterPlan,
  CapabilityContext,
  ImageAdapter,
  PlatformImageRequest,
} from './types'

export { agnesAdapter } from './agnes'
export { isResolutionTier } from './catalog'
export { geminiAdapter } from './gemini'
export { adaptGptRequest } from './gpt-request'
export { grokAdapter } from './grok'
export { openaiImagesDirect, openaiImagesSub2api } from './openai-images'
export { openaiResponsesAdapter } from './openai-responses'
export { stampReceipt } from './platform'
export type {
  AdapterCapabilities,
  AdapterPlan,
  CapabilityContext,
  ImageAdapter,
  PlatformImageRequest,
  ResolutionTier,
  RouteContext,
} from './types'

/** `/api/channels` 用的能力。不认识的模型返回 undefined，调用方保持原声明。 */
export function capabilitiesForModel(
  model: string,
  ctx: CapabilityContext,
): AdapterCapabilities | undefined {
  const family = findCatalogModel(model)?.family
  if (family === 'gemini') return geminiAdapter.capabilities(model, ctx)
  if (family === 'grok') return grokAdapter.capabilities(model, ctx)
  if (family === 'agnes') return agnesAdapter.capabilities(model, ctx)
  if (family === 'gpt' || isGptDirectModel(model)) {
    const adapter =
      isGptDirectModel(model) && ctx.directOn ? openaiImagesDirect : openaiImagesSub2api
    return adapter.capabilities(model, ctx)
  }
  return undefined
}

export interface DispatchedImagePlan {
  adapter: ImageAdapter
  plan: AdapterPlan
}

export function planDispatchedImage(input: {
  provider: QueueProvider
  model: string
  request: HydratedSubmitRequest
  style: ChannelRouteStyle
  gptRoute?: 'direct' | 'sub2api'
  supportsNativeN: boolean
  supportsModeration: boolean
  forceB64Json: boolean
  imageSizes?: readonly string[]
  imageResponsesModel?: string
  useImageResponses: boolean
  member: boolean
  directOn: boolean
}): DispatchedImagePlan | undefined {
  const adapter = adapterFor(input)
  if (!adapter) return undefined
  // 调度层已经有队列请求。平台请求只补 count，真正的 body 以 request 为准。
  const req: PlatformImageRequest = {
    prompt: input.request.prompt,
    count: Math.max(1, input.request.n ?? 1),
  }
  return {
    adapter,
    plan: adapter.plan(req, input.model, {
      member: input.member,
      directOn: input.directOn,
      request: input.request,
      supportsNativeN: input.supportsNativeN,
      supportsModeration: input.supportsModeration,
      forceB64Json: input.forceB64Json,
      ...(input.imageSizes ? { imageSizes: input.imageSizes } : {}),
      ...(input.gptRoute ? { gptRoute: input.gptRoute } : {}),
      ...(input.imageResponsesModel ? { imageResponsesModel: input.imageResponsesModel } : {}),
      vertex: input.style === 'vertex-generate-content',
    }),
  }
}

function adapterFor(input: {
  provider: QueueProvider
  style: ChannelRouteStyle
  gptRoute?: 'direct' | 'sub2api'
  useImageResponses: boolean
}): ImageAdapter | undefined {
  if (input.provider === 'gemini') return geminiAdapter
  if (input.useImageResponses) return openaiResponsesAdapter
  if (input.style === 'agnes-generations-json') return agnesAdapter
  if (input.style === 'grok-openai-images') return grokAdapter
  if (input.style === 'openai-images') {
    return input.gptRoute === 'direct' ? openaiImagesDirect : openaiImagesSub2api
  }
  return undefined
}

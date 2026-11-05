import type { HydratedSubmitRequest } from '../../imageArchive'
import type { UpstreamCallResult } from '../shared'

/** 平台分辨率档。Gemini 的 512 不进这套档位。 */
export type ResolutionTier = '1K' | '2K' | '4K'

/**
 * 平台语义的生图请求，前端、智能体和 CLI 共用。
 * 各适配器再把它收成上游真正接受的请求。
 */
export interface PlatformImageRequest {
  prompt: string
  ratio?: string
  resolution?: 'auto' | ResolutionTier
  count: number
  references?: string[]
  mask?: string
  format?: 'png' | 'jpeg' | 'webp'
  compression?: number
  background?: 'auto' | 'transparent' | 'opaque'
  moderation?: 'auto' | 'low'
  keepPrompt?: boolean
  thinking?: 'minimal' | 'high'
  /** 内部字段。主面板不再直接暴露，倍率仍按它算。 */
  quality?: 'low' | 'medium' | 'high'
  extra?: Record<string, unknown>
}

export interface AdapterCapabilities {
  tiers: ResolutionTier[]
  /** 要会员才能选的档，例如 ['4K']。 */
  memberTiers: ResolutionTier[]
  ratios: string[]
  maxCount: number
  /** false 表示这一侧由 BFF fan-out，不上游原生 n。 */
  nativeCount: { generate: boolean; edit: boolean }
  maxReferences: number
  mask: boolean
  formats: string[]
  background: boolean
  moderation: boolean
  /** sub2api 为 false：上游丢掉 size。 */
  honorsSize: boolean
  /** Codex 系网关要防改写前缀。 */
  promptGuard: 'none' | 'prefix'
}

export interface UpstreamCall {
  method: 'POST'
  path: string
  body: unknown
  multipart?: boolean
  /** 这一条上游请求计几张。原生 n 是 n，fan-out 是 1。 */
  images: number
}

export interface DroppedParam {
  param: string
  reason: string
}

export interface AdapterPlan {
  calls: UpstreamCall[]
  /** 真正生效、要写进结果回执的参数。不含参考图字节。 */
  applied: Record<string, unknown>
  /** 被丢弃或降档的参数。 */
  dropped: DroppedParam[]
  estimatedUsd?: number
  /**
   * 每次派发重新构造 body。FormData 被请求消费后不能复用；
   * JSON 可以反复交回同一个对象。
   */
  freshBody?: () => unknown
}

export interface ParsedImage {
  index: number
  mime: string
  revised_prompt?: string
  duration_seconds?: number
}

export interface Usage {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { image_tokens?: number; text_tokens?: number }
}

export interface ParsedUpstream {
  images: ParsedImage[]
  usage?: Usage
  /** 合并后的上游 payload。调度层把它交回任务结果。 */
  payload: unknown
}

export interface CapabilityContext {
  member: boolean
  directOn: boolean
}

/**
 * 规划一条平台请求时适配器能看到的路由事实。选路不在这里做。
 * `request` 在时优先用它组上游请求，避免平台档位再折回像素时丢掉自定义尺寸。
 */
export interface RouteContext extends CapabilityContext {
  request?: HydratedSubmitRequest
  supportsNativeN?: boolean
  supportsModeration?: boolean
  forceB64Json?: boolean
  imageSizes?: readonly string[]
  gptRoute?: 'direct' | 'sub2api'
  imageResponsesModel?: string
  /** Vertex 直连才按 imageSizes 把未开放的档收成最近一档。 */
  vertex?: boolean
}

export interface ImageAdapter {
  protocol:
    | 'openai-images'
    | 'openai-responses'
    | 'gemini-generate-content'
    | 'grok-imagine'
    | 'agnes'
  capabilities(model: string, ctx: CapabilityContext): AdapterCapabilities
  plan(req: PlatformImageRequest, model: string, ctx: RouteContext): AdapterPlan
  parse(results: UpstreamCallResult[]): ParsedUpstream
}

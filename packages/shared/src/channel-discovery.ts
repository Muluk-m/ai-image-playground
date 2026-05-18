/**
 * BFF channel 发现协议（BFF → web）。
 *
 * BFF 启动时读 `apps/bff/channels.json`，把每条 channel sanitize 后通过
 * `GET /api/channels` 暴露给前端 — 不返回 baseUrl / auth / allowedPaths
 * 这类只属于 BFF 内部的字段。前端拿到 DiscoveredChannel[] 后驱动 UI 渲染
 * 与 dispatch 走队列路径。
 */

/** Channel 在前端 UI / dispatch 层面的归类。决定走 OpenAI 兼容协议还是 Gemini 协议。 */
export type ChannelKind = 'openai-queue' | 'gemini-queue'

/** 模型的能力声明 — 前端用来决定能否走 edit / mask 等输入图路径。 */
export type ChannelCapability = 'generate' | 'edit'

export interface ChannelModel {
  id: string
  label: string
  capabilities: ChannelCapability[]
}

/**
 * 跟 BFF / 上游同名透传的请求侧默认值。前端在没有用户覆盖时按这里取。
 * 字段全可选 — channel 不显式设时按 BFF 默认或 OpenAI/Gemini 协议默认走。
 */
export interface ChannelDefaults {
  /** OpenAI 路径下走 `/v1/images` 还是 `/v1/responses`。 */
  apiMode?: 'images' | 'responses'
  /** 是否启用 codex CLI 兼容行为（部分 OpenAI 兼容代理网关需要这个 prompt 前缀）。 */
  codexCli?: boolean
  /** 单任务超时秒数（前端 poll 上限的提示，不强制）。 */
  timeout?: number
  /** Gemini 路径下是否要求 response_format=b64_json（某些代理需要）。 */
  responseFormatB64Json?: boolean
}

/**
 * `/api/channels` 单条 channel 响应。**故意不含** baseUrl / auth / allowedPaths：
 * 这三者是 BFF 私有 — 前端永远不需要知道上游真实地址或密钥引用。
 */
export interface DiscoveredChannel {
  id: string
  kind: ChannelKind
  label: string
  models: ChannelModel[]
  defaults: ChannelDefaults
}

/** `GET /api/channels` 响应体。 */
export interface ChannelDiscoveryResponse {
  channels: DiscoveredChannel[]
}

// 客户端 Channel / Profile 类型定义。
// 内置 channel 的 schema 真源是 BFF 端 apps/bff/channels.json；前端通过
// GET /api/channels 拿到 DiscoveredChannel[]（@image-playground/shared 定义），
// 本文件给它一个本地 alias `PublicChannel`。

import type { DiscoveredChannel } from '@image-playground/shared'

export type {
  ChannelCapability,
  ChannelDefaults,
  ChannelModel,
} from '@image-playground/shared'

/**
 * 请求协议族。灵感库清单用 `openai-compat` / `gemini`，内置 channel 用
 * `openai-queue` / `gemini-queue`。`toQueueProvider` 把两边收到同一条队列协议上。
 */
export type ProviderKind = 'openai-compat' | 'gemini' | 'openai-queue' | 'gemini-queue'

/** 客户端可见的 channel 视图（无凭据 / 无 baseUrl / 无 allowedPaths）。 */
export type PublicChannel = DiscoveredChannel

/**
 * 用户的活动配置。只有平台渠道：模型选择，不含密钥或自定义端点。
 * 旧本地存储里的 `user-byok` 记录在 `normalizeSettings` 时丢弃。
 */
export type ClientProfile = BuiltinEdgeProfile

export interface BuiltinEdgeProfile {
  id: string
  source: 'builtin-edge'
  channelId: string
  selectedModelId: string
}

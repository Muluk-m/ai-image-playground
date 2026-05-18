// 客户端 Channel / Profile 类型定义。
// 内置 channel 的 schema 真源是 BFF 端 apps/bff/channels.json；前端通过
// GET /api/channels 拿到 DiscoveredChannel[]（@image-playground/shared 定义），
// 本文件给它一个本地 alias `PublicChannel`，并补足 BYOK profile 相关类型。

import type { DiscoveredChannel } from '@image-playground/shared'

export type {
  ChannelCapability,
  ChannelDefaults,
  ChannelModel,
} from '@image-playground/shared'

/**
 * Profile 维度的 provider kind 联合。
 * - `openai-queue` / `gemini-queue`：内置 channel 用（BFF 队列模式）
 * - `openai-compat` / `gemini` / `http-template`：BYOK profile 用（浏览器直连上游）
 */
export type ProviderKind =
  | 'openai-compat'
  | 'gemini'
  | 'http-template'
  | 'openai-queue'
  | 'gemini-queue'

/** 客户端可见的 channel 视图（无凭据 / 无 baseUrl / 无 allowedPaths）。 */
export type PublicChannel = DiscoveredChannel

/**
 * 用户的活动配置 = 一个 ClientProfile。
 *
 * 两种形态由 `source` 区分；类型系统保证：
 * - builtin-edge 不含 apiKey / baseUrl / 运行时偏好
 * - user-byok 持完整凭据与 preferences
 */
export type ClientProfile = BuiltinEdgeProfile | UserByokProfile

export interface BuiltinEdgeProfile {
  id: string
  source: 'builtin-edge'
  channelId: string
  selectedModelId: string
}

export interface UserByokPreferences {
  apiMode: 'images' | 'responses'
  timeout: number
  codexCli: boolean
  apiProxy: boolean
  responseFormatB64Json?: boolean
}

export interface UserByokProfile {
  id: string
  source: 'user-byok'
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  models: string[]
  selectedModelId: string
  preferences: UserByokPreferences
}

// 客户端 Channel / Profile 类型定义。
// 服务端真源在 config/channels.json；本文件只描述「客户端可见」的字段。

export type ProviderKind =
  | 'openai-compat'
  | 'gemini'
  | 'http-template'
  | 'openai-queue'
  | 'gemini-queue'

export function isQueueKind(kind: ProviderKind): kind is 'openai-queue' | 'gemini-queue' {
  return kind === 'openai-queue' || kind === 'gemini-queue'
}

export type ChannelCapability = 'generate' | 'edit' | 'mask'

export interface ChannelModel {
  id: string
  label: string
  capabilities?: ChannelCapability[]
}

export interface ChannelDefaults {
  apiMode: 'images' | 'responses'
  timeout: number
  codexCli?: boolean
  responseFormatB64Json?: boolean
}

/** 客户端可见的 channel 视图（无凭据） */
export interface PublicChannel {
  id: string
  kind: ProviderKind
  label: string
  models: ChannelModel[]
  defaults: ChannelDefaults
  /** 内部下线开关；客户端读取时通过 getPublicChannels 过滤掉 */
  disabled?: boolean
  /** 仅 queue kind 必填：BFF 公网 base URL（含协议、不带尾斜杠） */
  bffBaseUrl?: string
}

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

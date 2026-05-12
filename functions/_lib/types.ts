// 服务端 channel 配置 = config/channels.json 中的完整记录（含凭据引用与白名单）。
// 客户端可见的子集见 src/lib/channels/types.ts (PublicChannel)。

export type ProviderKind = 'openai-compat' | 'gemini' | 'http-template'

export type ChannelAuth =
  | { type: 'bearer'; secretRef: string }
  | { type: 'query-key'; secretRef: string; queryParam?: string; headerName?: string }

export interface ChannelConfig {
  id: string
  kind: ProviderKind
  label: string
  baseUrl: string
  auth: ChannelAuth
  models: Array<{ id: string; label: string; capabilities?: string[] }>
  defaults: {
    apiMode: 'images' | 'responses'
    timeout: number
    codexCli?: boolean
    responseFormatB64Json?: boolean
  }
  allowedPaths: string[]
  disabled?: boolean
}

export interface ChannelsConfig {
  channels: ChannelConfig[]
}

export interface ProxyError {
  error: string
  [key: string]: unknown
}

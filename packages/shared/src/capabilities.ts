import { PROJECT_DOCUMENT_MAX_BYTES, PROJECT_ELEMENT_MAX_COUNT } from './project-protocol'

export const CAPABILITIES = {
  'accounts:local-recovery': { defaultValue: false, clientExposed: true },
  'accounts:login': { defaultValue: false, clientExposed: true },
  'accounts:email-verification': { defaultValue: false, clientExposed: true },
  'accounts:self-register': { defaultValue: false, clientExposed: true },
  'accounts:sync': { defaultValue: false, clientExposed: true },
  'agent:chat': { defaultValue: false, clientExposed: true },
  'billing:credits': { defaultValue: false, clientExposed: true },
  /**
   * 对话限时免费的运营期。开着时对话轮**真的不计费**：BFF 既不预扣也不结算
   * （`chatTurnsBilled()`），这一轮的 `cost.chat` 恒为 0；工具产生的生图 / 生视频
   * 各自独立计费，不受影响。前端据此在轮页脚标明这一轮的对话没收钱。
   */
  'billing:chat-free': { defaultValue: false, clientExposed: true },
  'generation:byok': { defaultValue: false, clientExposed: true },
  'generation:video': { defaultValue: false, clientExposed: true },
  'operator:console': { defaultValue: false, clientExposed: false },
  'quota:daily': { defaultValue: false, clientExposed: true },
} as const satisfies Record<`${string}:${string}`, CapabilityDefinition>

/**
 * 已下线能力的名字。旧运营配置里可能还留着它们，读配置时静默忽略而不是拒绝启动；
 * 不要复用这些名字表示新能力。
 */
export const RETIRED_CAPABILITIES: readonly string[] = [
  // 联网工具（搜索 / 抓网页 / 取网图 / 抓商品图）不再由能力开关控制，随部署默认在场。
  'agent:web',
  'generation:storyboard',
  'matte:server',
  'remix:analyze',
  'remix:listing',
]

/** 已经不存在的配额。部署里的旧配置文件不该因为改名而起不来，读到就跳过。 */
export const RETIRED_QUOTAS: readonly string[] = [
  'agent:compaction-keep-messages',
  'agent:compaction-max-folds',
]

export interface CapabilityDefinition {
  readonly defaultValue: false
  readonly clientExposed: boolean
}

export type CapabilityKey = keyof typeof CAPABILITIES

export type ClientCapabilityKey = {
  [Key in CapabilityKey]: (typeof CAPABILITIES)[Key]['clientExposed'] extends true ? Key : never
}[CapabilityKey]

export type CapabilityValues = { readonly [Key in CapabilityKey]: boolean }
export type ClientCapabilityManifest = { readonly [Key in ClientCapabilityKey]: boolean }
export interface AdminCapabilityManifest {
  readonly accounts_login: boolean
  readonly operator_console: boolean
}

export const QUOTAS = {
  'agent:compaction-buffer-tokens': { defaultValue: 13_000 },
  'agent:compaction-cooldown-minutes': { defaultValue: 6 * 60 },
  'agent:compaction-failure-threshold': { defaultValue: 3 },
  /** 近期原文保留多少 token。一条消息可能 1 token 也可能 1 万，按条数留在混合尺寸的会话里量不准。 */
  'agent:compaction-keep-tokens': { defaultValue: 20_000 },
  'agent:compaction-output-reserve-tokens': { defaultValue: 20_000 },
  'agent:compaction-verbatim-tokens': { defaultValue: 20_000 },
  /** 起一轮的速率限制，两维各一个阈值；0 关闭该维。 */
  'agent:turns-per-device-minute': { defaultValue: 20 },
  'agent:turns-per-ip-hour': { defaultValue: 600 },
  'generation:daily-images': { defaultValue: 0 },
  'sync:user-media-bytes': { defaultValue: 10 * 1024 * 1024 * 1024 },
  'sync:asset-image-bytes': { defaultValue: 10 * 1024 * 1024 },
  'sync:user-asset-bytes': { defaultValue: 500 * 1024 * 1024 },
  'sync:project-document-bytes': { defaultValue: PROJECT_DOCUMENT_MAX_BYTES },
  'sync:project-elements': { defaultValue: PROJECT_ELEMENT_MAX_COUNT },
  'sync:project-recycle-days': { defaultValue: 30 },
  'sync:user-projects': { defaultValue: 100 },
} as const satisfies Record<`${string}:${string}`, QuotaDefinition>

export interface QuotaDefinition {
  readonly defaultValue: number
}

export type QuotaKey = keyof typeof QUOTAS
export type QuotaValues = { readonly [Key in QuotaKey]: number }

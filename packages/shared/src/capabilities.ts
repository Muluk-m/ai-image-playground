export const CAPABILITIES = {
  'accounts:login': { defaultValue: false, clientExposed: true },
  'accounts:self-register': { defaultValue: false, clientExposed: true },
  'accounts:sync': { defaultValue: false, clientExposed: true },
  'agent:chat': { defaultValue: false, clientExposed: true },
  'billing:credits': { defaultValue: false, clientExposed: true },
  'generation:byok': { defaultValue: false, clientExposed: true },
  'generation:storyboard': { defaultValue: false, clientExposed: true },
  'generation:video': { defaultValue: false, clientExposed: true },
  'matte:server': { defaultValue: false, clientExposed: true },
  'operator:console': { defaultValue: false, clientExposed: false },
  'quota:daily': { defaultValue: false, clientExposed: true },
  'remix:analyze': { defaultValue: false, clientExposed: true },
  'remix:listing': { defaultValue: false, clientExposed: true },
} as const satisfies Record<`${string}:${string}`, CapabilityDefinition>

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
  /** 对话 token 计费：输出单价是输入单价的几倍，以及一轮预扣多少输出 token。 */
  'agent:chat-output-price-ratio': { defaultValue: 5 },
  'agent:chat-output-reserve-tokens': { defaultValue: 2_000 },
  'agent:compaction-buffer-tokens': { defaultValue: 13_000 },
  'agent:compaction-cooldown-minutes': { defaultValue: 6 * 60 },
  'agent:compaction-failure-threshold': { defaultValue: 3 },
  'agent:compaction-keep-messages': { defaultValue: 10 },
  'agent:compaction-max-folds': { defaultValue: 5 },
  'agent:compaction-output-reserve-tokens': { defaultValue: 20_000 },
  'agent:compaction-verbatim-tokens': { defaultValue: 20_000 },
  /** 起一轮的速率限制，两维各一个阈值；0 关闭该维。 */
  'agent:turns-per-device-minute': { defaultValue: 20 },
  'agent:turns-per-ip-hour': { defaultValue: 600 },
  'generation:daily-images': { defaultValue: 0 },
  'sync:asset-image-bytes': { defaultValue: 10 * 1024 * 1024 },
  'sync:user-asset-bytes': { defaultValue: 500 * 1024 * 1024 },
} as const satisfies Record<`${string}:${string}`, QuotaDefinition>

export interface QuotaDefinition {
  readonly defaultValue: number
}

export type QuotaKey = keyof typeof QUOTAS
export type QuotaValues = { readonly [Key in QuotaKey]: number }

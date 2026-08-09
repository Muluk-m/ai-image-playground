export const CAPABILITIES = {
  'accounts:login': { defaultValue: false, clientExposed: true },
  'billing:credits': { defaultValue: false, clientExposed: true },
  'generation:byok': { defaultValue: false, clientExposed: true },
  'operator:console': { defaultValue: false, clientExposed: false },
  'quota:daily': { defaultValue: false, clientExposed: true },
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

export const QUOTAS = {
  'generation:daily-images': { defaultValue: 0 },
} as const satisfies Record<`${string}:${string}`, QuotaDefinition>

export interface QuotaDefinition {
  readonly defaultValue: number
}

export type QuotaKey = keyof typeof QUOTAS
export type QuotaValues = { readonly [Key in QuotaKey]: number }

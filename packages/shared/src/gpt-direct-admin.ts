/** 后台直连面板上的一把密钥。只有指纹，没有密钥本身。 */
export type GptDirectKeyStatus = 'available' | 'cooldown' | 'disabled' | 'budget'

export interface GptDirectKeyView {
  ordinal: number
  fingerprint: string
  label: string
  status: GptDirectKeyStatus
  disabled_reason: 'quota' | 'invalid' | null
  budget_micro_usd: number
  spent_micro_usd: number
  cooldown_until: number | null
  last_error: string | null
  last_error_at: number | null
}

export interface GptDirectDaySpend {
  /** 台北时间的日期，YYYY-MM-DD。官方对账那一列除外，那是 UTC。 */
  day: string
  cost_micro_usd: number
  images: number
}

export interface GptDirectOfficialCosts {
  ok: boolean
  /** OpenAI Costs API 按 UTC 日给出的金额。 */
  days: Array<{ day: string; cost_micro_usd: number }>
}

/**
 * 直连花费面板。`currency_note` 固定是 usage：数字来自我们按 token 估算的花费，
 * 不是 OpenAI 账户余额。没配管理密钥时 `official` 为 null，后台不展示那一块。
 */
export interface GptDirectAdminView {
  generated_at: number
  currency_note: 'usage'
  days: 7 | 30
  keys: GptDirectKeyView[]
  total_spent_micro_usd: number
  total_budget_micro_usd: number
  remaining_micro_usd: number
  daily: GptDirectDaySpend[]
  official: GptDirectOfficialCosts | null
}

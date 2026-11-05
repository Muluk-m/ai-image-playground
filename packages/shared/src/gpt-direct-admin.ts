/** 后台直连面板上的一把密钥。只有指纹，没有密钥本身。 */
export type GptDirectKeyStatus = 'available' | 'cooldown' | 'disabled' | 'budget' | 'off'

export interface GptDirectKeyView {
  /** 后台行 id。环境变量密钥为 null，不能在这页改。 */
  id: string | null
  ordinal: number
  fingerprint: string
  label: string
  enabled: boolean
  source: 'admin' | 'env'
  status: GptDirectKeyStatus
  disabled_reason: 'quota' | 'invalid' | null
  /** 配置里的月预算（美元），没乘封顶比例。编辑时用这个，不用已经打折的封顶。 */
  budget_usd: number
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
  /** 当前生效的清单来自后台还是环境变量。 */
  source: 'admin' | 'env'
  /** 后台密钥行的最新更新时间。排序时带上，过期就拒绝。 */
  revision: number
  /** 指纹 HMAC 用的环境变量名，不是密钥本身。 */
  fingerprint_mac_source: string
  writable: boolean
  disabled_reason: string | null
  keys: GptDirectKeyView[]
  total_spent_micro_usd: number
  total_budget_micro_usd: number
  remaining_micro_usd: number
  daily: GptDirectDaySpend[]
  official: GptDirectOfficialCosts | null
}

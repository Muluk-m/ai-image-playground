/** 后台 Gemini 直连面板上的一把密钥。只有指纹，没有密钥本身。 */
export type GeminiDirectKeyStatus = 'available' | 'cooldown' | 'disabled' | 'budget' | 'off'

export interface GeminiDirectKeyView {
  /** 后台行 id。环境变量密钥为 null，不能在这页改。 */
  id: string | null
  ordinal: number
  fingerprint: string
  label: string
  enabled: boolean
  source: 'admin' | 'env'
  status: GeminiDirectKeyStatus
  disabled_reason: 'quota' | 'invalid' | null
  /** 配置里的月预算（美元），没乘封顶比例。编辑时用这个，不用已经打折的封顶。 */
  budget_usd: number
  budget_micro_usd: number
  spent_micro_usd: number
  /** 所选统计窗口（7 天 / 30 天）内这把密钥的调用统计。 */
  requests: number
  succeeded: number
  images: number
  rate_limited: number
  cooldown_until: number | null
  last_error: string | null
  last_error_at: number | null
}

export interface GeminiDirectDayStats {
  /** 台北时间日期，YYYY-MM-DD。 */
  day: string
  requests: number
  succeeded: number
  images: number
  rate_limited: number
  cost_micro_usd: number
}

export interface GeminiDirectModelStats {
  model: string
  requests: number
  succeeded: number
  images: number
  rate_limited: number
  cost_micro_usd: number
}

/**
 * Gemini 直连（Vertex / Nano Banana）密钥池与用量统计视图。
 * Google/Vertex 无单 Key 账单对账 API，费用为按响应 usageMetadata / 模型分辨率档位估算的美元值。
 */
export interface GeminiDirectAdminView {
  generated_at: number
  currency_note: 'estimated'
  days: 7 | 30
  /** 当前生效的清单来自后台还是环境变量。 */
  source: 'admin' | 'env'
  /** 后台密钥行的最新更新时间。排序时带上，过期就拒绝。 */
  revision: number
  /** 指纹 HMAC/scrypt 用的环境变量名，不是密钥本身。 */
  fingerprint_mac_source: string
  writable: boolean
  disabled_reason: string | null
  keys: GeminiDirectKeyView[]
  total_spent_micro_usd: number
  total_budget_micro_usd: number
  remaining_micro_usd: number
  window_requests: number
  window_succeeded: number
  window_images: number
  window_rate_limited: number
  window_cost_micro_usd: number
  daily: GeminiDirectDayStats[]
  by_model: GeminiDirectModelStats[]
}

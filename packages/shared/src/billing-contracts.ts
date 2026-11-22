/** 单个积分余额桶使用 PostgreSQL integer，调整前后都不能越界。 */
export const MAX_CREDIT_BALANCE = 2_147_483_647

export type CreditBucket = 'subscription' | 'recharge'
export type CreditLedgerEntryType =
  | 'grant'
  | 'expire'
  | 'hold'
  | 'commit'
  | 'release'
  | 'recharge'
  | 'adjustment'
export type SubscriptionStatus = 'active' | 'expired'
export type BillingPeriodMonths = 1 | 3 | 12

export interface ConfirmedPaymentInput {
  operation_id: string
  amount_cents: number
}

export interface ConfirmedPayment {
  id: string
  user_id: string
  kind: 'recharge' | 'subscription'
  amount_cents: number
  result: {
    subscription_id?: string
    ends_at?: number
    effective_at?: number
    action?: 'grant' | 'renew' | 'upgrade' | 'schedule'
  }
  operator_id: string
  created_at: number
  inviter_user_id: string | null
  paid_reward_basis_points: number | null
  credits_per_yuan: number | null
  reward_credits: number | null
}

export interface OperatorAccountSnapshot extends AccountSnapshot {
  payments: ConfirmedPayment[]
}

export interface CreditAccount {
  subscription_balance: number
  recharge_balance: number
  subscription_expires_at: number | null
}

export interface BillingPlanSummary {
  id: string
  name: string
  monthly_credits: number
  max_concurrent_tasks?: number
}

/** 已付款、下一计费周期才切换的换档。当前周期的套餐与额度不变。 */
export interface ScheduledPlanChange {
  plan_id: string
  plan_name: string
  period_months: BillingPeriodMonths
  effective_at: number
}

export interface Subscription {
  id: string
  status: SubscriptionStatus
  plan_id: string
  period_months: BillingPeriodMonths
  starts_at: number
  ends_at: number
  next_grant_at: number | null
  plan: BillingPlanSummary
  scheduled_change?: ScheduledPlanChange | null
}

export interface LedgerEntry {
  id: string
  user_id: string
  bucket: CreditBucket
  entry_type: CreditLedgerEntryType
  amount: number
  /** 已结算任务的净消耗；API 从任务占用关联提供，不写回审计流水。 */
  task_net_spend?: number | null
  task_hold_status?: 'held' | 'committed' | 'released' | null
  task_settled_at?: number | null
  task_id: string | null
  /** Persisted independent category; present even after transient worker rows are purged. */
  task_kind?: 'analysis' | null
  reference_id: string | null
  model: string | null
  quantity: number | null
  operator_id: string | null
  note: string | null
  metadata: Record<string, unknown>
  created_at: number
}

export type ModelPriceUnit = 'image' | 'second' | 'kilo_token'

export interface ModelPrice {
  model: string
  /** image 每张、second 每秒、kilo_token 每千输入 token。 */
  credits_per_image: number
  unit: ModelPriceUnit
  /** 对话模型才有：每千输出 token 的积分数与一轮预扣的输出 token 上限。 */
  output_credits_per_unit: number | null
  output_reserve_tokens: number | null
  cached_input_price_percent?: number
  active: boolean
  /** 系统自动下架的原因（上游没有可用账号）；运营手动下架与上架中为空。旧版 BFF 不返回。 */
  pause_reason?: 'upstream_unavailable' | null
  paused_at?: number | null
  updated_at: number
}

export interface ChatUsageSummary {
  turns: number
  input_tokens: number
  output_tokens: number
  credits: number
}

export interface PlanPrice {
  period_months: BillingPeriodMonths
  original_price_cents: number
  discount_price_cents: number | null
  discount_ends_at: number | null
  effective_price_cents: number
}

export interface Plan {
  id: string
  name: string
  monthly_credits: number
  max_concurrent_tasks?: number
  active: boolean
  sort_order: number
  updated_at: number
  prices: PlanPrice[]
}

export interface BillingSettings {
  payments_enabled?: boolean
  payment_channel?: 'wechat' | 'alipay'
  receiving_account?: string
  payment_code_id?: string
  contact_wechat: string
  payment_qr_url: string
  contact_qr_url: string
  guidance: string
}

/** 默认积分充值换算与档位；部署可通过 BFF 环境变量 BILLING_RECHARGE_* 覆盖。 */
export const DEFAULT_RECHARGE_CREDITS_PER_YUAN = 400
export const DEFAULT_RECHARGE_AMOUNTS_YUAN = [10, 50, 100] as const
export const RECHARGE_CREDITS_PER_YUAN = DEFAULT_RECHARGE_CREDITS_PER_YUAN
export const RECHARGE_AMOUNTS_YUAN: readonly number[] = DEFAULT_RECHARGE_AMOUNTS_YUAN

export interface Catalog {
  recharge_pricing?: { credits_per_yuan: number; amounts_yuan: number[] }
  plans: Plan[]
  settings: BillingSettings | null
  model_prices: ModelPrice[]
}

/** 未登录的定价页可读的价目。不含收款码、微信号和其它运营设置。 */
export interface PublicCatalog {
  plans: Array<{
    id: string
    name: string
    monthly_credits: number
    max_concurrent_tasks: number
    sort_order: number
    prices: PlanPrice[]
  }>
  recharge: { credits_per_yuan: number; amounts_yuan: number[] }
  image_anchor: { model: string; credits_per_image: number } | null
  referral: ReferralPolicy
}

export interface AccountSnapshot {
  account: CreditAccount | null
  subscription: Subscription | null
  ledger: LedgerEntry[]
  model_prices: ModelPrice[]
  /** Authorization state for private identities without a usable entitlement. */
  access_state?: 'access_denied' | null
  unmetered?: {
    user_id: string
    daily_quota: number
    guaranteed_concurrency: number
    idle_concurrency: number
    enabled: boolean
    updated_at: number
  } | null
}

export interface UserAccountSnapshot extends AccountSnapshot {
  catalog: Catalog
}

export interface UserSummaryResponse {
  summaries: Array<{
    user_id: string
    subscription_balance: number
    recharge_balance: number
    subscription_expires_at: number | null
    subscription: {
      plan_id: string
      plan_name: string
      ends_at: number
      status: SubscriptionStatus
    } | null
    registration_source: 'invited' | 'direct_or_unknown'
    inviter: {
      user_id: string
      username: string
    } | null
  }>
}

export interface LedgerPage {
  ledger: LedgerEntry[]
  next_offset: number | null
}

export interface SpendActivityDay {
  date: string
  count: number
}

export interface SpendActivity {
  from: string
  to: string
  timezone: string
  days: SpendActivityDay[]
}

export interface BillingOverview {
  accounts: number
  active_subscriptions: number
  subscription_credits: number
  recharge_credits: number
}

export interface ReferralPolicy {
  inviter_registration_credits: number
  invitee_registration_credits: number
  paid_reward_basis_points: number
  credits_per_yuan: number
}

export interface ReferralSummary {
  code: string
  share_path: string
  invitation_count: number
  reward_balance: number
  total_rewards: number
}

export interface ReferralRewardPage {
  rewards: Array<{
    id: string
    credits: number
    created_at: number
    status: 'available' | 'transferred'
  }>
  next_offset: number | null
}

export interface ReferralTransferResult {
  transferred_credits: number
  summary: ReferralSummary
}

export type PurchaseOrderStatus =
  | 'pending'
  | 'review'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'expired'
export interface PaymentCodeVersion {
  id: string
  channel: 'wechat' | 'alipay'
  account: string
  url: string
}
export interface PurchaseOrder {
  kind?: 'subscription' | 'recharge'
  recharge_credits?: number | null
  id: string
  code: string
  user_id: string
  plan_id: string | null
  plan_name: string | null
  period_months: BillingPeriodMonths | null
  /** 首购、同档续费、立即生效的升档，或到期后生效的降档。充值订单为空。 */
  subscription_action?: 'grant' | 'renew' | 'upgrade' | 'schedule' | null
  amount_cents: number
  status: PurchaseOrderStatus
  created_at: number
  expires_at: number
  claimed_at: number | null
  completed_at: number | null
  ends_at: number | null
  review_note: string
  payment_code: PaymentCodeVersion
  payment_history: Array<PaymentCodeVersion & { shown_at: number }>
  payment_available: boolean
  contact_qr_url: string
  contact_wechat: string
  notification_status: 'none' | 'pending' | 'claimed' | 'sent' | 'failed' | 'unknown'
}
export interface OrderReceipt {
  channel: 'wechat' | 'alipay'
  receiving_account: string
  payment_code_id: string
  transaction_id: string | null
  amount_cents: number
  received_at: number
  received_at_source?: 'confirmation'
  note: string
}
export type OrderConfirmation = Omit<
  OrderReceipt,
  'transaction_id' | 'received_at' | 'received_at_source'
> & {
  transaction_id?: string
  received_at?: number
}
export interface OperatorPurchaseOrder extends PurchaseOrder {
  username: string
  receipt: OrderReceipt | null
  history: Array<{ action: string; operator_id: string; note: string; at: number }>
}

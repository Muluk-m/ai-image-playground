import type {
  OperatorPurchaseOrder,
  OrderReceipt,
  PaymentCodeVersion,
  PurchaseOrderStatus,
} from '@image-playground/shared'
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import type { DbHandle } from '../client'
import { epochMs } from './common'

export { epochMs }

export type ModelPriceUnit = 'image' | 'second' | 'kilo_token'
export type ModelPauseReason = 'upstream_unavailable'

export const modelPrices = pgTable('billing_model_prices', {
  model: text('model').primaryKey(),
  /** 单价的计价单位数：image 每张、second 每秒、kilo_token 每千输入 token。 */
  credits_per_image: integer('credits_per_image').notNull(),
  unit: text('unit').$type<ModelPriceUnit>().notNull().default('image'),
  /** 对话模型才有：每千输出 token 的积分数与一轮预扣的输出 token 上限。 */
  output_credits_per_unit: integer('output_credits_per_unit'),
  output_reserve_tokens: integer('output_reserve_tokens'),
  /** Percentage of ordinary input price; zero preserves historical free cache reads. */
  cached_input_price_percent: integer('cached_input_price_percent').notNull().default(0),
  active: boolean('active').notNull().default(true),
  /** 系统自动下架的原因；运营手动下架为空。恢复上架时清空。 */
  pause_reason: text('pause_reason').$type<ModelPauseReason>(),
  paused_at: epochMs('paused_at'),
  updated_at: epochMs('updated_at').notNull(),
})

export const plans = pgTable('billing_plans', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  monthly_credits: integer('monthly_credits').notNull(),
  max_concurrent_tasks: integer('max_concurrent_tasks').notNull().default(1),
  /** 服务器空闲时最多同时跑几个（弹性名额）；NULL = 只按 max_concurrent_tasks。 */
  idle_concurrent_tasks: integer('idle_concurrent_tasks'),
  active: boolean('active').notNull().default(true),
  sort_order: integer('sort_order').notNull(),
  updated_at: epochMs('updated_at').notNull(),
})

export const planPrices = pgTable(
  'billing_plan_prices',
  {
    plan_id: text('plan_id')
      .notNull()
      .references(() => plans.id),
    period_months: integer('period_months').notNull(),
    original_price_cents: integer('original_price_cents').notNull(),
    discount_price_cents: integer('discount_price_cents'),
    discount_ends_at: epochMs('discount_ends_at'),
    updated_at: epochMs('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.plan_id, table.period_months] })],
)

export const billingSettings = pgTable('billing_settings', {
  id: text('id').primaryKey(),
  contact_wechat: text('contact_wechat').notNull().default(''),
  payment_qr_url: text('payment_qr_url').notNull().default(''),
  contact_qr_url: text('contact_qr_url').notNull().default(''),
  payments_enabled: boolean('payments_enabled').notNull().default(false),
  payment_channel: text('payment_channel').$type<'wechat' | 'alipay'>().notNull().default('wechat'),
  receiving_account: text('receiving_account').notNull().default(''),
  payment_code_id: text('payment_code_id').notNull().default(''),
  guidance: text('guidance').notNull().default('联系客服完成转账后，请发送用户名与付款截图。'),
  updated_at: epochMs('updated_at').notNull(),
})

export const creditAccounts = pgTable('billing_credit_accounts', {
  user_id: text('user_id').primaryKey(),
  subscription_balance: integer('subscription_balance').notNull().default(0),
  recharge_balance: integer('recharge_balance').notNull().default(0),
  subscription_expires_at: epochMs('subscription_expires_at'),
  updated_at: epochMs('updated_at').notNull(),
})

export const subscriptions = pgTable(
  'billing_subscriptions',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull(),
    plan_id: text('plan_id')
      .notNull()
      .references(() => plans.id),
    period_months: integer('period_months').notNull(),
    starts_at: epochMs('starts_at').notNull(),
    ends_at: epochMs('ends_at').notNull(),
    next_grant_at: epochMs('next_grant_at'),
    status: text('status').notNull(),
    /** 已付款、下一计费周期才生效的换档。当前周期仍用 plan_id。 */
    scheduled_plan_id: text('scheduled_plan_id').references(() => plans.id),
    scheduled_period_months: integer('scheduled_period_months'),
    scheduled_effective_at: epochMs('scheduled_effective_at'),
    scheduled_order_id: text('scheduled_order_id'),
    created_at: epochMs('created_at').notNull(),
    updated_at: epochMs('updated_at').notNull(),
  },
  (table) => [
    index('idx_billing_subscriptions_user').on(table.user_id, table.ends_at.desc()),
    uniqueIndex('idx_billing_subscriptions_active_user')
      .on(table.user_id)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex('billing_subscriptions_scheduled_order')
      .on(table.scheduled_order_id)
      .where(sql`${table.scheduled_order_id} IS NOT NULL`),
  ],
)

export const taskHolds = pgTable(
  'billing_task_holds',
  {
    task_id: text('task_id').primaryKey(),
    user_id: text('user_id').notNull(),
    subscription_amount: integer('subscription_amount').notNull(),
    recharge_amount: integer('recharge_amount').notNull(),
    subscription_expires_at: epochMs('subscription_expires_at'),
    total_amount: integer('total_amount').notNull(),
    /** 预扣时的单价快照，0007 之前的 hold 为空。回读价表会让中途改价改写在途任务的账。 */
    credits_per_unit: integer('credits_per_unit'),
    model: text('model').notNull(),
    quantity: integer('quantity').notNull(),
    status: text('status').notNull(),
    /** 对话任务结算时上游报的用量；其它任务与上游没报用量的对话轮为空。 */
    input_tokens: integer('input_tokens'),
    cached_input_tokens: integer('cached_input_tokens'),
    output_tokens: integer('output_tokens'),
    /** 净消耗：预扣减实际退回，口径同 netSpendPerTask。未结算的 hold 为空。 */
    net_spend: integer('net_spend'),
    created_at: epochMs('created_at').notNull(),
    settled_at: epochMs('settled_at'),
  },
  (table) => [
    index('idx_billing_task_holds_settled_user')
      .on(table.user_id)
      .where(sql`${table.status} = 'committed'`),
  ],
)

export const creditLedger = pgTable(
  'billing_credit_ledger',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull(),
    bucket: text('bucket').notNull(),
    entry_type: text('entry_type').notNull(),
    amount: integer('amount').notNull(),
    task_id: text('task_id'),
    reference_id: text('reference_id'),
    model: text('model'),
    quantity: integer('quantity'),
    operator_id: text('operator_id'),
    note: text('note'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    created_at: epochMs('created_at').notNull(),
  },
  (table) => [
    index('idx_billing_ledger_user_time').on(
      table.user_id,
      table.created_at.desc(),
      table.id.desc(),
    ),
    index('idx_billing_ledger_task').on(table.task_id),
  ],
)

export const confirmedPayments = pgTable(
  'billing_confirmed_payments',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull(),
    kind: text('kind').$type<'recharge' | 'subscription'>().notNull(),
    amount_cents: integer('amount_cents').notNull(),
    request_hash: text('request_hash').notNull(),
    inviter_user_id: text('inviter_user_id'),
    paid_reward_basis_points: integer('paid_reward_basis_points'),
    credits_per_yuan_scaled: bigint('credits_per_yuan_scaled', { mode: 'number' }),
    reward_credits: integer('reward_credits'),
    result: jsonb('result')
      .$type<{
        subscription_id?: string
        ends_at?: number
        effective_at?: number
        action?: 'grant' | 'renew' | 'upgrade' | 'schedule'
      }>()
      .notNull()
      .default({}),
    operator_id: text('operator_id').notNull(),
    created_at: epochMs('created_at').notNull(),
  },
  (table) => [index('idx_billing_payments_user_time').on(table.user_id, table.created_at.desc())],
)

export const referralPolicy = pgTable('billing_referral_policy', {
  id: text('id').primaryKey(),
  inviter_registration_credits: integer('inviter_registration_credits').notNull(),
  invitee_registration_credits: integer('invitee_registration_credits').notNull(),
  paid_reward_basis_points: integer('paid_reward_basis_points').notNull(),
  credits_per_yuan_scaled: bigint('credits_per_yuan_scaled', { mode: 'number' }).notNull(),
  updated_at: epochMs('updated_at').notNull(),
})

export const referralProfiles = pgTable('billing_referral_profiles', {
  user_id: text('user_id').primaryKey(),
  code: text('code').notNull().unique(),
  reward_balance: integer('reward_balance').notNull().default(0),
  total_rewards: bigint('total_rewards', { mode: 'number' }).notNull().default(0),
  created_at: epochMs('created_at').notNull(),
})

export const referralRelationships = pgTable(
  'billing_referral_relationships',
  {
    user_id: text('user_id').primaryKey(),
    inviter_user_id: text('inviter_user_id').notNull(),
    created_at: epochMs('created_at').notNull(),
  },
  (table) => [index('idx_billing_referrals_inviter').on(table.inviter_user_id)],
)

export const referralTransfers = pgTable('billing_referral_transfers', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull(),
  credits: integer('credits').notNull(),
  created_at: epochMs('created_at').notNull(),
})

export const referralRewards = pgTable(
  'billing_referral_rewards',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull(),
    kind: text('kind')
      .$type<'registration_inviter' | 'registration_invitee' | 'payment'>()
      .notNull(),
    source_id: text('source_id').notNull(),
    credits: integer('credits').notNull(),
    transfer_id: text('transfer_id'),
    created_at: epochMs('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_billing_reward_source').on(table.user_id, table.kind, table.source_id),
    index('idx_billing_rewards_user_time').on(
      table.user_id,
      table.created_at.desc(),
      table.id.desc(),
    ),
  ],
)

export type BillingTransaction = Parameters<Parameters<DbHandle['transaction']>[0]>[0]

export const purchaseOrders = pgTable(
  'billing_purchase_orders',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull().unique(),
    request_id: text('request_id').notNull(),
    user_id: text('user_id').notNull(),
    plan_id: text('plan_id').references(() => plans.id),
    kind: text('kind').$type<'subscription' | 'recharge'>().notNull().default('subscription'),
    recharge_credits: integer('recharge_credits'),
    plan_name: text('plan_name'),
    period_months: integer('period_months'),
    amount_cents: integer('amount_cents').notNull(),
    status: text('status').$type<PurchaseOrderStatus>().notNull(),
    created_at: epochMs('created_at').notNull(),
    expires_at: epochMs('expires_at').notNull(),
    claimed_at: epochMs('claimed_at'),
    completed_at: epochMs('completed_at'),
    starts_at: epochMs('starts_at'),
    ends_at: epochMs('ends_at'),
    review_note: text('review_note').notNull().default(''),
    rejection_message: text('rejection_message').notNull().default(''),
    payment_code: jsonb('payment_code').$type<PaymentCodeVersion>().notNull(),
    payment_history: jsonb('payment_history')
      .$type<Array<PaymentCodeVersion & { shown_at: number }>>()
      .notNull()
      .default([]),
    receipt_channel: text('receipt_channel'),
    receipt_account: text('receipt_account'),
    receipt_transaction: text('receipt_transaction'),
    receipt: jsonb('receipt').$type<OrderReceipt>(),
    history: jsonb('history').$type<OperatorPurchaseOrder['history']>().notNull().default([]),
    notification_status: text('notification_status')
      .$type<OperatorPurchaseOrder['notification_status']>()
      .notNull()
      .default('pending'),
    notification_at: epochMs('notification_at'),
    /** 订阅订单在下单时确定：首购、同档续费、立即生效的升档，或到期后生效的降档。充值订单为空。 */
    subscription_action: text('subscription_action').$type<
      'grant' | 'renew' | 'upgrade' | 'schedule'
    >(),
  },
  (table) => [
    uniqueIndex('billing_orders_user_request').on(table.user_id, table.request_id),
    index('billing_orders_status_time').on(table.status, table.created_at),
  ],
)

export const orderRequestAliases = pgTable(
  'billing_order_request_aliases',
  {
    user_id: text('user_id').notNull(),
    request_id: text('request_id').notNull(),
    order_id: text('order_id')
      .notNull()
      .references(() => purchaseOrders.id),
  },
  (table) => [primaryKey({ columns: [table.user_id, table.request_id] })],
)
export const unmeteredEntitlements = pgTable('billing_unmetered_entitlements', {
  user_id: text('user_id').primaryKey(),
  daily_quota: integer('daily_quota').notNull().default(20),
  guaranteed_concurrency: integer('guaranteed_concurrency').notNull().default(2),
  idle_concurrency: integer('idle_concurrency').notNull().default(0),
  enabled: boolean('enabled').notNull().default(true),
  updated_at: epochMs('updated_at').notNull(),
})

/** Durable account classification; unlike an OAuth identity this survives provider unlinking. */
export const accountFacts = pgTable('billing_account_facts', {
  user_id: text('user_id').primaryKey(),
  category: text('category').$type<'feishu_unmetered'>().notNull(),
  created_at: epochMs('created_at').notNull(),
})

export const unmeteredQuota = pgTable(
  'billing_unmetered_quota',
  {
    user_id: text('user_id').notNull(),
    date: text('date').notNull(),
    units: integer('units').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.user_id, table.date] }),
    index('idx_billing_unmetered_quota_date').on(table.date),
  ],
)

/**
 * 定价页展示用的公开价目。
 *
 * 数字跟私有计费种子对齐，页面不能 import `private/`：
 * - 套餐与标价：`private/apps/bff/billing/migrations/0000_billing.sql`
 * - 并发：`0013_plan_concurrency.sql`（入门保持默认 1）
 * - 入门首月 ¥39 的折扣截止 2026-09-01，已过期，这里只用原价
 * - 充值：`private/apps/recharge-pricing.config.json`（1 元 400 积分，10 / 50 / 100 元）
 * - 张数：`gpt-image-2` 种子价每张 100 积分
 * - 邀请：注册双方各 200；付费返利 5%，按 100 积分/元折进奖励余额
 */

export const BILLING_CYCLES = [1, 3, 12] as const
export type BillingCycle = (typeof BILLING_CYCLES)[number]

export const GPT_IMAGE_2_CREDITS = 100

export interface PricingPlan {
  id: 'starter' | 'standard' | 'professional'
  monthlyCredits: number
  concurrency: number
  featured: boolean
  /** 整个周期一次付清的金额，单位分。 */
  prices: Record<BillingCycle, number>
}

export const PRICING_PLANS: readonly PricingPlan[] = [
  {
    id: 'starter',
    monthlyCredits: 66_000,
    concurrency: 1,
    featured: false,
    prices: { 1: 4900, 3: 14700, 12: 58800 },
  },
  {
    id: 'standard',
    monthlyCredits: 220_000,
    concurrency: 2,
    featured: true,
    prices: { 1: 12900, 3: 38700, 12: 154800 },
  },
  {
    id: 'professional',
    monthlyCredits: 600_000,
    concurrency: 3,
    featured: false,
    prices: { 1: 29900, 3: 89700, 12: 358800 },
  },
]

export const RECHARGE_CREDITS_PER_YUAN = 400
export const RECHARGE_AMOUNTS_YUAN = [10, 50, 100] as const

export const REFERRAL_REGISTRATION_CREDITS = 200

export function imagesPerMonth(monthlyCredits: number): number {
  return Math.floor(monthlyCredits / GPT_IMAGE_2_CREDITS)
}

export function rechargeCredits(yuan: number): number {
  return yuan * RECHARGE_CREDITS_PER_YUAN
}

/** 季付、年付折成每月。种子价正好整除，没有年付折扣。 */
export function monthlyEquivalentCents(cents: number, cycle: BillingCycle): number {
  return cents / cycle
}

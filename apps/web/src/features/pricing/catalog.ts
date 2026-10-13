/**
 * 定价页展示用的公开价目。
 *
 * 页面不能 import `private/`。标价抄自生产库 `billing_plan_prices`
 * （2026-10-13 读取 image_playground_paid），不是迁移种子：
 * 种子里的入门首月 ¥39 已在 2026-09-01 过期，后台后来改过三档原价和折扣。
 * 折扣截止与私有 `effectivePrice` 一致：`now > discountEndsAt` 之后回到原价。
 * 积分、并发、充值和邀请仍跟种子与充值配置一致。
 */

export const BILLING_CYCLES = [1, 3, 12] as const
export type BillingCycle = (typeof BILLING_CYCLES)[number]

export const GPT_IMAGE_2_CREDITS = 100

/** 生产库三档折扣的共同截止时间：2027-02-28 15:59:59Z。 */
export const PLAN_DISCOUNT_ENDS_AT = Date.parse('2027-02-28T15:59:59Z')

export interface PlanPrice {
  originalCents: number
  discountCents: number | null
  discountEndsAt: number | null
}

export interface PricingPlan {
  id: 'starter' | 'standard' | 'professional'
  monthlyCredits: number
  concurrency: number
  featured: boolean
  prices: Record<BillingCycle, PlanPrice>
}

function quote(originalCents: number, discountCents: number): PlanPrice {
  return { originalCents, discountCents, discountEndsAt: PLAN_DISCOUNT_ENDS_AT }
}

export const PRICING_PLANS: readonly PricingPlan[] = [
  {
    id: 'starter',
    monthlyCredits: 66_000,
    concurrency: 1,
    featured: false,
    prices: {
      1: quote(4900, 3900),
      3: quote(13500, 10500),
      12: quote(46800, 34800),
    },
  },
  {
    id: 'standard',
    monthlyCredits: 220_000,
    concurrency: 2,
    featured: true,
    prices: {
      1: quote(9900, 7900),
      3: quote(26700, 21300),
      12: quote(94800, 70800),
    },
  },
  {
    id: 'professional',
    monthlyCredits: 600_000,
    concurrency: 3,
    featured: false,
    prices: {
      1: quote(19900, 15900),
      3: quote(53700, 42900),
      12: quote(190800, 142800),
    },
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

/** 与私有账本 `effectivePrice` 相同：截止时刻仍然算折扣价。 */
export function effectivePriceCents(price: PlanPrice, now = Date.now()): number {
  if (price.discountCents === null || price.discountEndsAt === null || now > price.discountEndsAt) {
    return price.originalCents
  }
  return price.discountCents
}

/** 季付、年付折成每月，单位分。 */
export function monthlyEquivalentCents(cents: number, cycle: BillingCycle): number {
  return cents / cycle
}

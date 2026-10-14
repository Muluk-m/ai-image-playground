/**
 * 定价页从 BFF 的公开价目读取套餐、折扣、充值和邀请。
 * 不 import `private/`，也不调用需要登录的 `/api/billing/catalog`。
 * 折扣是否生效由服务端计算，页面只展示返回的 effective price。
 */
import { bffBaseUrl } from '../../lib/runtimeConfig'

export const BILLING_CYCLES = [1, 3, 12] as const
export type BillingCycle = (typeof BILLING_CYCLES)[number]

export interface PublicPlanPrice {
  originalCents: number
  effectiveCents: number
}

export interface PublicPlan {
  id: string
  name: string
  monthlyCredits: number
  concurrency: number
  sortOrder: number
  prices: Partial<Record<BillingCycle, PublicPlanPrice>>
}

export interface PublicCatalog {
  plans: PublicPlan[]
  recharge: { creditsPerYuan: number; amountsYuan: number[] }
  imageAnchor: { model: string; creditsPerImage: number } | null
  referral: {
    inviterCredits: number
    inviteeCredits: number
    paidRewardBasisPoints: number
    creditsPerYuan: number
  }
}

export function imagesPerMonth(monthlyCredits: number, creditsPerImage: number): number {
  if (creditsPerImage <= 0) return 0
  return Math.floor(monthlyCredits / creditsPerImage)
}

export function rechargeCredits(yuan: number, creditsPerYuan: number): number {
  return yuan * creditsPerYuan
}

/** 季付、年付折成每月，单位分。 */
export function monthlyEquivalentCents(cents: number, cycle: BillingCycle): number {
  return cents / cycle
}

export function parsePublicCatalog(input: unknown): PublicCatalog | null {
  if (!isObject(input)) return null
  const plans = parsePlans(input.plans)
  const recharge = parseRecharge(input.recharge)
  const referral = parseReferral(input.referral)
  if (!plans || !recharge || !referral) return null
  return {
    plans,
    recharge,
    imageAnchor: parseImageAnchor(input.image_anchor),
    referral,
  }
}

export async function loadPublicCatalog(fetcher: typeof fetch = fetch): Promise<PublicCatalog> {
  const response = await fetcher(`${bffBaseUrl()}/api/billing/public-catalog`, {
    cache: 'no-store',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const catalog = parsePublicCatalog(await response.json())
  if (!catalog) throw new Error('invalid_catalog')
  return catalog
}

function parsePlans(input: unknown): PublicPlan[] | null {
  if (!Array.isArray(input)) return null
  const plans: PublicPlan[] = []
  for (const row of input) {
    if (!isObject(row) || typeof row.id !== 'string' || typeof row.name !== 'string') return null
    if (!isSafeInt(row.monthly_credits) || !isSafeInt(row.max_concurrent_tasks)) return null
    if (!isSafeInt(row.sort_order) || !Array.isArray(row.prices)) return null
    const prices: PublicPlan['prices'] = {}
    for (const price of row.prices) {
      if (!isObject(price)) return null
      // 页面只展示月付、季付、年付。多出来的周期留给以后的购买流，不让整页失败。
      if (!isCycle(price.period_months)) continue
      if (!isSafeInt(price.original_price_cents) || !isSafeInt(price.effective_price_cents)) {
        return null
      }
      prices[price.period_months] = {
        originalCents: price.original_price_cents,
        effectiveCents: price.effective_price_cents,
      }
    }
    plans.push({
      id: row.id,
      name: row.name,
      monthlyCredits: row.monthly_credits,
      concurrency: row.max_concurrent_tasks,
      sortOrder: row.sort_order,
      prices,
    })
  }
  plans.sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
  return plans
}

function parseRecharge(input: unknown): PublicCatalog['recharge'] | null {
  if (!isObject(input) || !isSafeInt(input.credits_per_yuan) || input.credits_per_yuan <= 0) {
    return null
  }
  if (!Array.isArray(input.amounts_yuan) || input.amounts_yuan.length === 0) return null
  if (!input.amounts_yuan.every((yuan) => isSafeInt(yuan) && yuan > 0)) return null
  return { creditsPerYuan: input.credits_per_yuan, amountsYuan: input.amounts_yuan }
}

function parseReferral(input: unknown): PublicCatalog['referral'] | null {
  if (!isObject(input)) return null
  if (
    !isSafeInt(input.inviter_registration_credits) ||
    !isSafeInt(input.invitee_registration_credits) ||
    !isSafeInt(input.paid_reward_basis_points) ||
    typeof input.credits_per_yuan !== 'number' ||
    !Number.isFinite(input.credits_per_yuan) ||
    input.credits_per_yuan <= 0
  ) {
    return null
  }
  return {
    inviterCredits: input.inviter_registration_credits,
    inviteeCredits: input.invitee_registration_credits,
    paidRewardBasisPoints: input.paid_reward_basis_points,
    creditsPerYuan: input.credits_per_yuan,
  }
}

function parseImageAnchor(input: unknown): PublicCatalog['imageAnchor'] {
  if (input === null || input === undefined) return null
  if (!isObject(input) || typeof input.model !== 'string' || input.model.length === 0) return null
  if (!isSafeInt(input.credits_per_image) || input.credits_per_image <= 0) return null
  return { model: input.model, creditsPerImage: input.credits_per_image }
}

function isCycle(value: unknown): value is BillingCycle {
  return value === 1 || value === 3 || value === 12
}

function isSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

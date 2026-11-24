import { createHash, randomUUID } from 'node:crypto'
import {
  billingSettings,
  type ModelPriceUnit,
  modelPrices,
  planPrices,
  plans,
} from '@image-playground/db/billing'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { config } from '../../config'
import { db, schema as publicSchema } from '../../db/client'
import type { BffTransaction, PrivateTaskHooks, TaskUsage } from '../../lib/billing-hooks'
import { isCapabilityEnabled } from '../../lib/capabilities'
import { getChannels } from '../../lib/channels'
import { reservedTokenUsage } from '../../lib/token-pricing'
import { creditsFor, effectivePrice } from './calculations'
import { rechargeAmountsYuan, rechargeCreditsPerYuan } from './config'
import { getReferralPolicy } from './referrals'
import { settledAmount } from './settlement'

const OPERATOR_ID = 'admin'

export async function modelAvailabilityActive(tx: BffTransaction, model: string): Promise<boolean> {
  const [availability] = await tx
    .select({ active: publicSchema.model_availability.active })
    .from(publicSchema.model_availability)
    .where(eq(publicSchema.model_availability.model, model))
    .limit(1)
  return availability?.active ?? true
}

export async function quoteTokenTask(
  input: Parameters<NonNullable<PrivateTaskHooks['quoteTokenTask']>>[0],
) {
  const { tx, model, estimatedInputTokens } = input
  if (!isCapabilityEnabled('billing:credits')) return null
  if (!Number.isSafeInteger(estimatedInputTokens) || estimatedInputTokens < 0) return null
  const [price] = await tx
    .select()
    .from(modelPrices)
    .where(and(eq(modelPrices.model, model), eq(modelPrices.unit, 'kilo_token')))
    .limit(1)
    .for('share')
  if (
    !price ||
    !(await modelAvailabilityActive(tx, model)) ||
    price.credits_per_image <= 0 ||
    !price.output_credits_per_unit ||
    price.output_credits_per_unit <= 0 ||
    !price.output_reserve_tokens ||
    price.output_reserve_tokens <= 0 ||
    price.cached_input_price_percent < 0 ||
    price.cached_input_price_percent > 100
  )
    return null
  const rates = {
    outputPriceRatio: price.output_credits_per_unit / price.credits_per_image,
    outputReserveTokens: price.output_reserve_tokens,
    cachedInputPriceRatio: price.cached_input_price_percent / 100,
  }
  const usage = reservedTokenUsage(estimatedInputTokens, rates)
  const exemption = !isCapabilityEnabled('billing:credits')
    ? ('non-billing' as const)
    : isCapabilityEnabled('billing:chat-free')
      ? ('chat-free' as const)
      : ('none' as const)
  return {
    estimatedCredits: creditsFor({ creditsPerUnit: price.credits_per_image, ...usage }),
    pricing: {
      model,
      unit: 'kilo_token' as const,
      ...usage,
      baseUnitCredits: price.credits_per_image,
      ...rates,
      inputEstimateTokens: estimatedInputTokens,
      exemption,
      pricingVersion: createHash('sha256')
        .update(JSON.stringify({ price, exemption }))
        .digest('hex'),
      quotedAt: Date.now(),
      validUntil: null,
    },
  }
}

export async function quoteTask(input: Parameters<NonNullable<PrivateTaskHooks['quoteTask']>>[0]) {
  const { tx, model, quantity, unitMultiplier } = input
  if (!isCapabilityEnabled('billing:credits')) return null
  const [price] = await tx
    .select()
    .from(modelPrices)
    .where(and(eq(modelPrices.model, model), inArray(modelPrices.unit, ['image', 'second'])))
    .limit(1)
    .for('share')
  if (!price || !(await modelAvailabilityActive(tx, model))) return null
  const pricingVersion = createHash('sha256').update(JSON.stringify(price)).digest('hex')
  return {
    estimatedCredits: creditsFor({
      creditsPerUnit: price.credits_per_image,
      quantity,
      unitMultiplier,
    }),
    pricing: {
      model,
      unit: price.unit,
      quantity,
      unitMultiplier,
      baseUnitCredits: price.credits_per_image,
      outputPriceRatio: 0,
      cachedInputPriceRatio: price.cached_input_price_percent / 100,
      inputEstimateTokens: 0,
      outputReserveTokens: 0,
      exemption: 'none' as const,
      pricingVersion,
      quotedAt: Date.now(),
      // A later confirmation must revalidate pricingVersion in its reservation transaction.
      validUntil: null,
    },
  }
}

export async function getCatalog(
  options: { includeInactivePlans?: boolean } = {},
  now = Date.now(),
) {
  const planRowsPromise = options.includeInactivePlans
    ? db.select().from(plans).orderBy(asc(plans.sort_order))
    : db.select().from(plans).where(eq(plans.active, true)).orderBy(asc(plans.sort_order))
  const [planRows, priceRows, settingRows, rawModelRows, availabilityRows] = await Promise.all([
    planRowsPromise,
    db.select().from(planPrices),
    db.select().from(billingSettings).where(eq(billingSettings.id, 'default')).limit(1),
    db.select().from(modelPrices).orderBy(asc(modelPrices.model)),
    db
      .select({
        model: publicSchema.model_availability.model,
        active: publicSchema.model_availability.active,
      })
      .from(publicSchema.model_availability),
  ])
  const availabilityByModel = new Map(availabilityRows.map((row) => [row.model, row.active]))
  const modelRows = rawModelRows.map((row) => ({
    ...row,
    active: availabilityByModel.get(row.model) ?? true,
  }))
  return {
    plans: planRows.map((plan) => ({
      ...plan,
      prices: priceRows
        .filter((price) => price.plan_id === plan.id)
        .map((price) => ({
          ...price,
          effective_price_cents: effectivePrice(
            price.original_price_cents,
            price.discount_price_cents,
            price.discount_ends_at,
            now,
          ),
        })),
    })),
    recharge_pricing: {
      credits_per_yuan: rechargeCreditsPerYuan,
      amounts_yuan: [...rechargeAmountsYuan],
    },
    settings: settingRows[0] ?? null,
    model_prices: modelRows,
  }
}

/**
 * 定价页折算张数用的图片模型：先用产品默认的 Image 2.5 Flare，没有上架单价时退回 gpt-image-2。
 * 改默认模型时这份顺序跟着改。
 */
const PUBLIC_IMAGE_ANCHOR_MODELS = ['gpt-image-2.5-flare', 'gpt-image-2'] as const

/** 公开价目。折扣是否生效由服务端按 effectivePrice 算，页面不再自带一份快照。 */
export async function getPublicCatalog(now = Date.now()) {
  const [catalog, referral] = await Promise.all([getCatalog({}, now), getReferralPolicy()])
  const priced = catalog.model_prices.filter(
    (price) => price.active && price.unit === 'image' && price.credits_per_image > 0,
  )
  const anchor = PUBLIC_IMAGE_ANCHOR_MODELS.map((model) =>
    priced.find((price) => price.model === model),
  ).find((price) => price !== undefined)
  return {
    plans: catalog.plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      monthly_credits: plan.monthly_credits,
      max_concurrent_tasks: plan.max_concurrent_tasks ?? 1,
      sort_order: plan.sort_order,
      prices: plan.prices.map((price) => ({
        period_months: price.period_months,
        original_price_cents: price.original_price_cents,
        discount_price_cents: price.discount_price_cents,
        discount_ends_at: price.discount_ends_at,
        effective_price_cents: price.effective_price_cents,
      })),
    })),
    recharge: {
      credits_per_yuan: rechargeCreditsPerYuan,
      amounts_yuan: [...rechargeAmountsYuan],
    },
    image_anchor: anchor
      ? { model: anchor.model, credits_per_image: anchor.credits_per_image }
      : null,
    referral,
  }
}

export interface ModelPriceUpdate {
  operatorId?: string
  model: string
  /** unit 为 kilo_token 时是每千输入 token 的积分数。 */
  creditsPerUnit: number
  unit?: ModelPriceUnit
  /** 对话模型必填：每千输出 token 的积分数与一轮预扣的输出 token 上限。 */
  outputCreditsPerUnit?: number
  outputReserveTokens?: number
  cachedInputPricePercent?: number
}

const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0

export async function updateModelPrice(input: ModelPriceUpdate) {
  const { model, creditsPerUnit } = input
  const unit: ModelPriceUnit = input.unit ?? 'image'
  if (!positive(creditsPerUnit)) throw new Error('invalid_price')
  const chat = unit === 'kilo_token'
  const outputCreditsPerUnit = chat ? (input.outputCreditsPerUnit ?? 0) : null
  const outputReserveTokens = chat ? (input.outputReserveTokens ?? 0) : null
  if (chat && !(positive(outputCreditsPerUnit) && positive(outputReserveTokens))) {
    throw new Error('invalid_chat_pricing')
  }
  if (
    input.cachedInputPricePercent !== undefined &&
    (!Number.isInteger(input.cachedInputPricePercent) ||
      input.cachedInputPricePercent < 0 ||
      input.cachedInputPricePercent > 100)
  ) {
    throw new Error('invalid_cached_input_price')
  }
  const cachedPrice =
    input.cachedInputPricePercent === undefined
      ? {}
      : { cached_input_price_percent: input.cachedInputPricePercent }
  const now = Date.now()
  const row = {
    ...cachedPrice,
    credits_per_image: creditsPerUnit,
    unit,
    output_credits_per_unit: outputCreditsPerUnit,
    output_reserve_tokens: outputReserveTokens,
    updated_at: now,
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(modelPrices)
      .values({ model, active: true, ...row })
      .onConflictDoUpdate({ target: modelPrices.model, set: row })
    await tx.insert(publicSchema.operator_audits).values({
      id: randomUUID(),
      operator_id: input.operatorId ?? OPERATOR_ID,
      action: 'billing.model_price.update',
      target_type: 'model',
      target_id: model,
      details: {
        ...cachedPrice,
        credits_per_image: creditsPerUnit,
        unit,
        ...(chat
          ? {
              output_credits_per_unit: outputCreditsPerUnit,
              output_reserve_tokens: outputReserveTokens,
            }
          : {}),
      },
      created_at: now,
    })
  })
}

/**
 * 公开树拿倍数与预留来折算 token；原价由私有账本按起轮时的单价快照计算。
 */
export async function getChatPricing(model: string, tx?: BffTransaction) {
  if (!isCapabilityEnabled('billing:credits')) return null
  const [price] = await (tx ?? db)
    .select()
    .from(modelPrices)
    .where(and(eq(modelPrices.model, model), eq(modelPrices.unit, 'kilo_token')))
    .limit(1)
  if (!price?.output_credits_per_unit || !price.output_reserve_tokens) return null
  const creditsPerUnit = price.credits_per_image
  return {
    cachedInputPriceRatio: price.cached_input_price_percent / 100,
    outputPriceRatio: price.output_credits_per_unit / creditsPerUnit,
    outputReserveTokens: price.output_reserve_tokens,
    quoteCredits(reserved: TaskUsage, actual?: TaskUsage) {
      const reservedAmount = creditsFor({ creditsPerUnit, ...reserved })
      return actual ? settledAmount({ creditsPerUnit, ...actual, reservedAmount }) : reservedAmount
    },
  }
}

const SHIPPED_CHAT_PRICE = {
  credits_per_image: 6,
  unit: 'kilo_token' as const,
  output_credits_per_unit: 30,
  output_reserve_tokens: 2_000,
}

/** 后台只编辑已有的行，所以对话模型得先有一行运营才配得上。 */
export async function ensureChatModelPrice(): Promise<void> {
  if (!isCapabilityEnabled('agent:chat') || !config.agent.model) return
  await db
    .insert(modelPrices)
    .values({
      model: config.agent.model,
      ...SHIPPED_CHAT_PRICE,
      active: true,
      updated_at: Date.now(),
    })
    .onConflictDoNothing()
}

export async function syncModelPricesFromChannels(): Promise<void> {
  if (!isCapabilityEnabled('billing:credits')) return
  const units = new Map<string, ModelPriceUnit>()
  for (const channel of getChannels()) {
    for (const model of channel.models) {
      units.set(model.id, model.media === 'video' ? 'second' : 'image')
    }
  }
  if (units.size === 0) return
  const now = Date.now()
  await db
    .insert(modelPrices)
    .values(
      Array.from(units, ([model, unit]) => ({
        model,
        credits_per_image: 100,
        unit,
        active: true,
        updated_at: now,
      })),
    )
    // 单价与启用状态归运营，计价单位跟着 channel 的 media 走，所以只有它覆盖既有行。
    // 对话那一行除外：改成 image 会让对话定价静默失效，而哪里都不报错。
    .onConflictDoUpdate({
      target: modelPrices.model,
      set: { unit: sql`excluded.unit` },
      setWhere: sql`${modelPrices.unit} <> 'kilo_token'`,
    })
}

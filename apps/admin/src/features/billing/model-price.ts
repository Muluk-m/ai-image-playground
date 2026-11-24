import { MAX_CREDIT_BALANCE, type ModelPrice } from '@image-playground/shared'

export type ModelPriceKind = 'chat' | 'image' | 'video'

export interface ModelPriceForm {
  amount: string
  outputAmount: string
  reserveTokens: string
  cachedInputPercent: string
}

export const UNIT_LABELS: Record<ModelPrice['unit'], string> = {
  image: '积分 / 张',
  second: '积分 / 秒',
  kilo_token: '输入（积分/千tok）',
}

export const SHORT_UNIT_LABELS: Record<ModelPrice['unit'], string> = {
  image: '积分/张',
  second: '积分/秒',
  kilo_token: '积分/千tok',
}

export const CHAT_PRICE_LABELS = {
  outputAmount: '输出（积分/千tok）',
  reserveTokens: '输出预留（token）',
  cachedInputPercent: '缓存计价（%原价）',
}

export function isChatPrice(price: ModelPrice): boolean {
  return price.unit === 'kilo_token'
}

export function defaultModelPriceForKind(model: string, kind: ModelPriceKind): ModelPrice {
  if (kind === 'chat') {
    return {
      model,
      credits_per_image: 6,
      unit: 'kilo_token',
      output_credits_per_unit: 30,
      output_reserve_tokens: 2000,
      cached_input_price_percent: 0,
      active: true,
      updated_at: 0,
    }
  }
  if (kind === 'video') {
    return {
      model,
      credits_per_image: 50,
      unit: 'second',
      output_credits_per_unit: null,
      output_reserve_tokens: null,
      active: true,
      updated_at: 0,
    }
  }
  return {
    model,
    credits_per_image: 100,
    unit: 'image',
    output_credits_per_unit: null,
    output_reserve_tokens: null,
    active: true,
    updated_at: 0,
  }
}

export function formatCreditsAsYuan(creditsAmount: number, creditsPerYuan?: number): string | null {
  if (
    !Number.isFinite(creditsAmount) ||
    creditsAmount < 0 ||
    !creditsPerYuan ||
    !Number.isFinite(creditsPerYuan) ||
    creditsPerYuan <= 0
  ) {
    return null
  }
  const yuan = creditsAmount / creditsPerYuan
  if (yuan === 0) return '¥0'
  if (yuan >= 1 && Number.isInteger(yuan)) return `¥${yuan}`
  if (yuan >= 0.01) return `¥${yuan.toFixed(2).replace(/\.?0+$/, '')}`
  return `¥${yuan.toFixed(4).replace(/\.?0+$/, '')}`
}

export function centsToYuanInput(cents: number | null): string {
  if (cents === null || !Number.isFinite(cents)) return ''
  const yuan = cents / 100
  return Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2).replace(/0$/, '')
}

export function yuanInputToCents(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) return Number.NaN
  return Math.round(Number(trimmed) * 100)
}

export function previewReferralCredits(input: {
  paymentYuan: number
  percent: number
  creditsPerYuan: number
}): number | null {
  if (
    !Number.isFinite(input.paymentYuan) ||
    input.paymentYuan <= 0 ||
    !Number.isFinite(input.percent) ||
    input.percent <= 0 ||
    !Number.isFinite(input.creditsPerYuan) ||
    input.creditsPerYuan <= 0
  ) {
    return 0
  }
  const scaledPayment = Math.round(input.paymentYuan * 100)
  const scaledPercent = Math.round(input.percent * 100)
  const scaledRate = Math.round(input.creditsPerYuan * 10_000)
  if (
    !Number.isSafeInteger(scaledPayment) ||
    !Number.isSafeInteger(scaledPercent) ||
    !Number.isSafeInteger(scaledRate)
  ) {
    return null
  }
  const computed =
    (BigInt(scaledPayment) * BigInt(scaledPercent) * BigInt(scaledRate)) / 10_000_000_000n
  if (computed > BigInt(MAX_CREDIT_BALANCE)) return null
  return Number(computed)
}

export function modelPriceFormValues(price: ModelPrice): ModelPriceForm {
  return {
    amount: String(price.credits_per_image),
    outputAmount:
      price.output_credits_per_unit === null ? '' : String(price.output_credits_per_unit),
    reserveTokens: price.output_reserve_tokens === null ? '' : String(price.output_reserve_tokens),
    cachedInputPercent: String(price.cached_input_price_percent ?? 0),
  }
}

export function modelPriceRequest(price: ModelPrice, input: ModelPriceForm) {
  return {
    credits_per_image: Number(input.amount),
    unit: price.unit,
    ...(isChatPrice(price)
      ? {
          output_credits_per_unit: Number(input.outputAmount),
          output_reserve_tokens: Number(input.reserveTokens),
          cached_input_price_percent: Number(input.cachedInputPercent),
        }
      : {}),
  }
}

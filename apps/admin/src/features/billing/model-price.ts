import type { ModelPrice } from '@image-playground/shared'

export interface ModelPriceForm {
  amount: string
  outputAmount: string
  reserveTokens: string
  cachedInputPercent: string
}

export const UNIT_LABELS: Record<ModelPrice['unit'], string> = {
  image: '积分 / 张',
  second: '积分 / 秒',
  kilo_token: '输入 · 积分 / 千 token',
}

export const CHAT_PRICE_LABELS = {
  outputAmount: '输出 · 积分 / 千 token',
  reserveTokens: '输出预留 · token',
  cachedInputPercent: '缓存输入 · 普通输入价格 %',
}

export function isChatPrice(price: ModelPrice): boolean {
  return price.unit === 'kilo_token'
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

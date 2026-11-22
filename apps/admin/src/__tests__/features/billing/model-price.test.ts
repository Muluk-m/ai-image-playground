import type { ModelPrice } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import { modelPriceFormValues, modelPriceRequest } from '../../../features/billing/model-price'

function price(model: string, patch: Partial<ModelPrice> = {}): ModelPrice {
  return {
    model,
    credits_per_image: 10,
    unit: 'image',
    output_credits_per_unit: null,
    output_reserve_tokens: null,
    active: true,
    updated_at: 0,
    ...patch,
  }
}

describe('模型单价请求', () => {
  it('只提交价格，上下架归公开侧的「模型」页', () => {
    const image = price('gpt-image-2')
    expect(modelPriceRequest(image, { ...modelPriceFormValues(image), amount: '12' })).toEqual({
      credits_per_image: 12,
      unit: 'image',
    })
  })

  it('对话模型带上输出单价、缓存比例与输出预留', () => {
    const chat = price('gpt-6-sol', {
      unit: 'kilo_token',
      credits_per_image: 6,
      output_credits_per_unit: 30,
      output_reserve_tokens: 2000,
      cached_input_price_percent: 10,
    })
    expect(modelPriceRequest(chat, modelPriceFormValues(chat))).toEqual({
      credits_per_image: 6,
      unit: 'kilo_token',
      output_credits_per_unit: 30,
      output_reserve_tokens: 2000,
      cached_input_price_percent: 10,
    })
  })
})

import type { ModelPrice } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import {
  centsToYuanInput,
  defaultModelPriceForKind,
  formatCreditsAsYuan,
  modelPriceFormValues,
  modelPriceRequest,
  previewReferralCredits,
  yuanInputToCents,
} from '../../../features/billing/model-price'

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

describe('模型单价请求与单位折算', () => {
  it('只提交价格，上下架归公开侧的「模型与计费」页', () => {
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

  it('为尚未入库的新模型按模态生成可提交的初始化定价模板', () => {
    const chatDraft = defaultModelPriceForKind('claude-sonnet-4-5', 'chat')
    expect(modelPriceRequest(chatDraft, modelPriceFormValues(chatDraft))).toEqual({
      credits_per_image: 6,
      unit: 'kilo_token',
      output_credits_per_unit: 30,
      output_reserve_tokens: 2000,
      cached_input_price_percent: 0,
    })
    const videoDraft = defaultModelPriceForKind('veo-3', 'video')
    expect(modelPriceRequest(videoDraft, modelPriceFormValues(videoDraft))).toEqual({
      credits_per_image: 50,
      unit: 'second',
    })
  })

  it('按充值汇率折算人民币参考单价，并精确转换套餐元与分', () => {
    expect(formatCreditsAsYuan(100, 100)).toBe('¥1')
    expect(formatCreditsAsYuan(6, 100)).toBe('¥0.06')
    expect(centsToYuanInput(2900)).toBe('29')
    expect(centsToYuanInput(2990)).toBe('29.9')
    expect(centsToYuanInput(2995)).toBe('29.95')
    expect(yuanInputToCents('29.9')).toBe(2990)
    expect(yuanInputToCents('19.99')).toBe(1999)
    expect(yuanInputToCents('')).toBeNull()
    expect(Number.isNaN(yuanInputToCents('12.345'))).toBe(true)
  })

  it('实时返利试算与服务端向下取整口径一致', () => {
    expect(previewReferralCredits({ paymentYuan: 99, percent: 15, creditsPerYuan: 100 })).toBe(1485)
    expect(previewReferralCredits({ paymentYuan: 29, percent: 12.5, creditsPerYuan: 100 })).toBe(
      362,
    )
    expect(previewReferralCredits({ paymentYuan: 100, percent: 10, creditsPerYuan: 19.9 })).toBe(
      199,
    )
    expect(previewReferralCredits({ paymentYuan: 99, percent: 0, creditsPerYuan: 100 })).toBe(0)
  })
})

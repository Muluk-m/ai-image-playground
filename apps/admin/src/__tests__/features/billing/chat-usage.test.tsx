import type { BillingOverview, ChatUsageSummary, ModelPrice } from '@image-playground/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatUsageFacts } from '../../../features/billing/chat-usage'
import {
  isChatPrice,
  modelPriceFormValues,
  modelPriceRequest,
} from '../../../features/billing/model-price'
import { OverviewPanel } from '../../../features/billing/OverviewPanel'

const USAGE: ChatUsageSummary = {
  turns: 42,
  input_tokens: 1_280_000,
  output_tokens: 96_000,
  credits: 10_560,
}

const CHAT_PRICE: ModelPrice = {
  model: 'fixture-agent-model',
  credits_per_image: 6,
  unit: 'kilo_token',
  output_credits_per_unit: 30,
  output_reserve_tokens: 2_000,
  active: true,
  updated_at: 0,
}

const IMAGE_PRICE: ModelPrice = {
  model: 'fixture-image-model',
  credits_per_image: 100,
  unit: 'image',
  output_credits_per_unit: null,
  output_reserve_tokens: null,
  active: true,
  updated_at: 0,
}

describe('ChatUsageFacts', () => {
  it('沿用积分账户那套事实行展示输入、输出与折算积分', () => {
    const html = renderToStaticMarkup(<ChatUsageFacts usage={USAGE} />)
    expect(html).toContain('输入 token')
    expect(html).toContain('1,280,000')
    expect(html).toContain('输出 token')
    expect(html).toContain('96,000')
    expect(html).toContain('折算积分')
    expect(html).toContain('10,560')
  })
})

describe('OverviewPanel', () => {
  it('在计费指标旁边给出全站对话消耗', () => {
    const client = new QueryClient()
    client.setQueryData(['private-billing', 'overview'], {
      accounts: 12,
      active_subscriptions: 3,
      subscription_credits: 4_500,
      recharge_credits: 1_600,
    } satisfies BillingOverview)
    client.setQueryData(['private-billing', 'chat-usage', '/api/private/billing/chat-usage'], USAGE)
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <OverviewPanel />
      </QueryClientProvider>,
    )
    expect(html).toContain('aria-label="对话消耗"')
    expect(html).toContain('1,280,000')
    expect(html).toContain('96,000')
    expect(html).toContain('10,560')
  })
})

describe('对话模型单价表单', () => {
  it('输入单价、输出单价与输出预留上限各占一个字段', () => {
    expect(isChatPrice(CHAT_PRICE)).toBe(true)
    expect(modelPriceFormValues(CHAT_PRICE)).toEqual({
      amount: '6',
      outputAmount: '30',
      reserveTokens: '2000',
      cachedInputPercent: '0',
    })
  })

  it('保存时把三个值一起发给 BFF', () => {
    expect(
      modelPriceRequest(CHAT_PRICE, {
        amount: '8',
        outputAmount: '40',
        reserveTokens: '3000',
        cachedInputPercent: '10',
      }),
    ).toEqual({
      credits_per_image: 8,
      unit: 'kilo_token',
      output_credits_per_unit: 40,
      output_reserve_tokens: 3_000,
      cached_input_price_percent: 10,
    })
  })

  it('图片模型只发一个单价', () => {
    expect(isChatPrice(IMAGE_PRICE)).toBe(false)
    expect(
      modelPriceRequest(IMAGE_PRICE, {
        amount: '100',
        outputAmount: '',
        reserveTokens: '',
        cachedInputPercent: '0',
      }),
    ).toEqual({ credits_per_image: 100, unit: 'image' })
  })
})

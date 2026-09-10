import { describe, expect, it } from 'bun:test'

process.env.DATABASE_URL = 'postgres://unused/agent-billing'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'

const { actualChatUsage, FALLBACK_CHAT_PRICING, reservedChatUsage } = await import(
  '../../../lib/agent/billing'
)

/** 私有钩子的算法：单价 × 数量 × 倍率后向上取整。整张单价表只有正整数。 */
function credits(creditsPerUnit: number, usage: { quantity: number; unitMultiplier: number }) {
  return Math.ceil(creditsPerUnit * usage.quantity * usage.unitMultiplier)
}

describe('FALLBACK_CHAT_PRICING', () => {
  it('ships the B tier: output priced five times input, reserve capped at 2000 tokens', () => {
    expect(FALLBACK_CHAT_PRICING).toEqual({ outputPriceRatio: 5, outputReserveTokens: 2_000 })
  })
})

describe('reservedChatUsage', () => {
  it('reserves the estimated input plus the whole output ceiling', () => {
    expect(reservedChatUsage(3_000, FALLBACK_CHAT_PRICING)).toEqual({
      quantity: 1,
      unitMultiplier: 13,
    })
  })

  it('turns a unit price of 6 into 6 per thousand input and 30 per thousand output', () => {
    expect(credits(6, reservedChatUsage(3_000, FALLBACK_CHAT_PRICING))).toBe(18 + 60)
  })

  it('follows the operator-configured output price and reserve', () => {
    expect(reservedChatUsage(3_000, { outputPriceRatio: 4, outputReserveTokens: 500 })).toEqual({
      quantity: 1,
      unitMultiplier: 5,
    })
  })
})

describe('actualChatUsage', () => {
  it('prices what the gateway reported at the same two rates', () => {
    const usage = actualChatUsage({ inputTokens: 2_000, outputTokens: 400 }, FALLBACK_CHAT_PRICING)
    expect(usage).toEqual({
      quantity: 1,
      unitMultiplier: 4,
      tokens: { input: 2_000, output: 400 },
    })
    expect(credits(6, usage)).toBe(12 + 12)
  })

  it('rounds a sub-credit turn up to one credit', () => {
    expect(
      credits(6, actualChatUsage({ inputTokens: 1, outputTokens: 1 }, FALLBACK_CHAT_PRICING)),
    ).toBe(1)
  })

  it('carries the reported token counts through for the operator console', () => {
    const usage = actualChatUsage({ inputTokens: 12, outputTokens: 4 }, FALLBACK_CHAT_PRICING)
    expect(usage.tokens).toEqual({ input: 12, output: 4 })
  })
})

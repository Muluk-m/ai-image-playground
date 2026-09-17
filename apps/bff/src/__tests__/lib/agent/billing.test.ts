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
})

describe('cached input settlement', () => {
  const pricing = { outputPriceRatio: 5, outputReserveTokens: 1500, cachedInputPriceRatio: 0.1 }
  it('charges cached input once at one tenth, then rounds the whole turn once', () => {
    const usage = actualChatUsage(
      { inputTokens: 10000, cachedInputTokens: 8000, outputTokens: 1000 },
      pricing,
    )
    expect(usage.unitMultiplier).toBeCloseTo(7.8)
    expect(usage.tokens).toEqual({ input: 10000, cachedInput: 8000, output: 1000 })
    expect(credits(1, usage)).toBe(8)
  })
  it('settles fully cached input without treating the call as missing usage', () => {
    expect(
      credits(
        1,
        actualChatUsage({ inputTokens: 10000, cachedInputTokens: 10000, outputTokens: 0 }, pricing),
      ),
    ).toBe(1)
  })
  it('reserves ordinary input price because cache hits are unknown before the request', () => {
    expect(reservedChatUsage(10000, pricing).unitMultiplier).toBe(17.5)
  })
  it('keeps cache reads free until the private overlay configures their rate', () => {
    expect(
      actualChatUsage(
        { inputTokens: 10000, cachedInputTokens: 10000, outputTokens: 0 },
        FALLBACK_CHAT_PRICING,
      ).unitMultiplier,
    ).toBe(0)
  })
})

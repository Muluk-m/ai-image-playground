import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

process.env.DATABASE_URL = 'postgres://unused/agent-billing'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'

const { loadOperatorConfig } = await import('../../../lib/operator-config')
const { actualChatUsage, chatBillingSettings, reservedChatUsage } = await import(
  '../../../lib/agent/billing'
)

const shipped = chatBillingSettings(loadOperatorConfig(null).quotas)

/** 私有钩子的算法：单价 × 数量 × 倍率后向上取整。整张单价表只有正整数。 */
function credits(creditsPerUnit: number, usage: { quantity: number; unitMultiplier: number }) {
  return Math.ceil(creditsPerUnit * usage.quantity * usage.unitMultiplier)
}

describe('chatBillingSettings', () => {
  it('ships the B tier: output priced five times input, reserve capped at 2000 tokens', () => {
    expect(shipped).toEqual({ outputPriceRatio: 5, outputReserveTokens: 2_000 })
  })

  it('takes both values from the operator config', () => {
    const { quotas } = loadOperatorConfig(
      resolve(import.meta.dir, '../../agent-billing-operator-config.json'),
    )
    expect(chatBillingSettings(quotas)).toEqual({
      outputPriceRatio: 4,
      outputReserveTokens: 500,
    })
  })
})

describe('reservedChatUsage', () => {
  it('reserves the estimated input plus the whole output ceiling', () => {
    expect(reservedChatUsage(3_000, shipped)).toEqual({ quantity: 1, unitMultiplier: 13 })
  })

  it('turns a unit price of 6 into 6 per thousand input and 30 per thousand output', () => {
    expect(credits(6, reservedChatUsage(3_000, shipped))).toBe(18 + 60)
  })
})

describe('actualChatUsage', () => {
  it('prices what the gateway reported at the same two rates', () => {
    const usage = actualChatUsage({ inputTokens: 2_000, outputTokens: 400 }, shipped)
    expect(usage).toEqual({ quantity: 1, unitMultiplier: 4 })
    expect(credits(6, usage)).toBe(12 + 12)
  })

  it('rounds a sub-credit turn up to one credit', () => {
    expect(credits(6, actualChatUsage({ inputTokens: 1, outputTokens: 1 }, shipped))).toBe(1)
  })
})

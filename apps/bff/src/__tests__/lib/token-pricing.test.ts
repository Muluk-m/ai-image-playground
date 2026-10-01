import { expect, it } from 'bun:test'
import { reservedTokenUsage, settledTokenUsage } from '../../lib/token-pricing'

it('reserves uncached input and preserves discounted, zero and unknown token settlement facts', () => {
  const pricing = {
    outputPriceRatio: 5,
    outputReserveTokens: 1500,
    cachedInputPriceRatio: 0.1,
  }
  expect(reservedTokenUsage(10000, pricing)).toEqual({ quantity: 1, unitMultiplier: 17.5 })
  expect(
    settledTokenUsage({ inputTokens: 10000, cachedInputTokens: 8000, outputTokens: 1000 }, pricing),
  ).toEqual({
    quantity: 1,
    unitMultiplier: 7.8,
    tokens: { input: 10000, cachedInput: 8000, output: 1000 },
  })
  expect(settledTokenUsage({ inputTokens: 0, outputTokens: 0 }, pricing)).toEqual({
    quantity: 1,
    unitMultiplier: 0,
    tokens: { input: 0, output: 0 },
  })
  expect(settledTokenUsage(null, pricing)).toBeUndefined()
})

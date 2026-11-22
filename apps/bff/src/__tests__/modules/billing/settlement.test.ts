import { describe, expect, it } from 'bun:test'
import { partialRefund, settledAmount } from '../../../modules/billing/settlement'

describe('settledAmount', () => {
  it('rounds the actual usage up to whole credits', () => {
    expect(
      settledAmount({ creditsPerUnit: 6, quantity: 1, unitMultiplier: 4.2, reservedAmount: 100 }),
    ).toBe(26)
  })

  it('caps usage above the reservation instead of charging more', () => {
    expect(
      settledAmount({ creditsPerUnit: 6, quantity: 1, unitMultiplier: 40, reservedAmount: 100 }),
    ).toBe(100)
  })

  it('settles zero when the upstream reported no usage', () => {
    expect(
      settledAmount({ creditsPerUnit: 6, quantity: 1, unitMultiplier: 0, reservedAmount: 100 }),
    ).toBe(0)
  })

  it('falls back to the reservation when the usage is not a usable number', () => {
    expect(
      settledAmount({
        creditsPerUnit: 6,
        quantity: 1,
        unitMultiplier: Number.NaN,
        reservedAmount: 100,
      }),
    ).toBe(100)
    expect(
      settledAmount({ creditsPerUnit: 6, quantity: 1, unitMultiplier: -3, reservedAmount: 100 }),
    ).toBe(100)
  })
})

describe('partialRefund', () => {
  it('keeps the settled amount in the subscription bucket first', () => {
    expect(partialRefund({ settled: 40, subscriptionHeld: 60, rechargeHeld: 40 })).toEqual({
      subscriptionRefund: 20,
      rechargeRefund: 40,
    })
  })

  it('draws on recharge credits only once the subscription share is used up', () => {
    expect(partialRefund({ settled: 80, subscriptionHeld: 60, rechargeHeld: 40 })).toEqual({
      subscriptionRefund: 0,
      rechargeRefund: 20,
    })
  })

  it('refunds everything when nothing was used', () => {
    expect(partialRefund({ settled: 0, subscriptionHeld: 60, rechargeHeld: 40 })).toEqual({
      subscriptionRefund: 60,
      rechargeRefund: 40,
    })
  })

  it('refunds nothing when the whole reservation was used', () => {
    expect(partialRefund({ settled: 100, subscriptionHeld: 60, rechargeHeld: 40 })).toEqual({
      subscriptionRefund: 0,
      rechargeRefund: 0,
    })
  })
})

import { describe, expect, it } from 'bun:test'
import {
  addCalendarMonths,
  allocateCredits,
  ceilCredits,
  creditsFor,
  effectivePrice,
  nextMonthlyOccurrence,
} from '../../../modules/billing/calculations'

describe('allocateCredits', () => {
  it('uses expiring subscription credits before recharge credits', () => {
    expect(allocateCredits(120, 80, 100)).toEqual({ ok: true, subscription: 80, recharge: 40 })
  })

  it('rejects the whole amount when the combined balance is short', () => {
    expect(allocateCredits(181, 80, 100)).toEqual({ ok: false, required: 181, available: 180 })
  })
})

describe('addCalendarMonths', () => {
  it('clamps month-end dates instead of overflowing into the next month', () => {
    const january31 = Date.UTC(2026, 0, 31, 12, 30)
    expect(new Date(addCalendarMonths(january31, 1)).toISOString()).toBe('2026-02-28T12:30:00.000Z')
  })

  it('uses calendar years for annual periods', () => {
    const leapDay = Date.UTC(2024, 1, 29)
    expect(new Date(addCalendarMonths(leapDay, 12)).toISOString()).toBe('2025-02-28T00:00:00.000Z')
  })

  it('keeps later occurrences anchored to a month-end start', () => {
    const january31 = Date.UTC(2026, 0, 31, 12, 30)
    const february28 = addCalendarMonths(january31, 1)
    expect(new Date(nextMonthlyOccurrence(january31, february28)).toISOString()).toBe(
      '2026-03-31T12:30:00.000Z',
    )
  })
})

describe('effectivePrice', () => {
  it('returns to original price after a limited discount expires', () => {
    expect(effectivePrice(4900, 3900, 1000, 1001)).toBe(4900)
    expect(effectivePrice(4900, 3900, 1000, 1000)).toBe(3900)
  })

  it('does not display a discount without an expiry', () => {
    expect(effectivePrice(4900, 3900, null, 1000)).toBe(4900)
  })
})

describe('creditsFor', () => {
  it('does not charge an extra credit for floating-point noise', () => {
    // 12 帧 GIF：980 / 100 = 9.8 倍，200 × 9.8 在浮点下是 1960.0000000000002。
    expect(200 * 9.8).toBeGreaterThan(1960)
    expect(creditsFor({ creditsPerUnit: 200, quantity: 1, unitMultiplier: 9.8 })).toBe(1960)
    expect(creditsFor({ creditsPerUnit: 240, quantity: 1, unitMultiplier: 9.8 })).toBe(2352)
    expect(creditsFor({ creditsPerUnit: 100, quantity: 3, unitMultiplier: 1.1 })).toBe(330)
  })

  it('still rounds a real fraction up', () => {
    expect(ceilCredits(100.4)).toBe(101)
    expect(ceilCredits(0.001)).toBe(1)
    expect(creditsFor({ creditsPerUnit: 3, quantity: 1, unitMultiplier: 0.5 })).toBe(2)
  })
})

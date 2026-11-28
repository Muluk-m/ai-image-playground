import { describe, expect, it } from 'vitest'
import {
  maxCycleDiscount,
  type PlanPeriodPriceEntry,
  summarizeDiscount,
  yearlyNudgeSavedCents,
} from '../../../features/pricing/discount'

const LIVE_PLANS: PlanPeriodPriceEntry[][] = [
  [
    { periodMonths: 1, originalCents: 4900, effectiveCents: 3900 },
    { periodMonths: 3, originalCents: 13500, effectiveCents: 10500 },
    { periodMonths: 12, originalCents: 46800, effectiveCents: 34800 },
  ],
  [
    { periodMonths: 1, originalCents: 9900, effectiveCents: 7900 },
    { periodMonths: 3, originalCents: 26700, effectiveCents: 21300 },
    { periodMonths: 12, originalCents: 94800, effectiveCents: 70800 },
  ],
  [
    { periodMonths: 1, originalCents: 19900, effectiveCents: 15900 },
    { periodMonths: 3, originalCents: 53700, effectiveCents: 42900 },
    { periodMonths: 12, originalCents: 190800, effectiveCents: 142800 },
  ],
]

describe('pricing discount summary', () => {
  it('computes single-month promo discount cleanly', () => {
    const starter = summarizeDiscount({
      periodMonths: 1,
      originalCents: 4900,
      effectiveCents: 3900,
      monthlyOriginalCents: 4900,
    })
    expect(starter.hasSavings).toBe(true)
    expect(starter.isPromo).toBe(true)
    expect(starter.compareOriginalCents).toBe(4900)
    expect(starter.savedCents).toBe(1000)
    expect(starter.savePercent).toBe(20)
    expect(starter.zhFold).toBe('8')
  })

  it('compares quarterly and yearly prices against monthly original × period', () => {
    const starterQuarter = summarizeDiscount({
      periodMonths: 3,
      originalCents: 13500,
      effectiveCents: 10500,
      monthlyOriginalCents: 4900,
    })
    expect(starterQuarter.compareOriginalCents).toBe(14700)
    expect(starterQuarter.savedCents).toBe(4200)
    expect(starterQuarter.savePercent).toBe(29)
    expect(starterQuarter.zhFold).toBe('7.1')

    const standardYear = summarizeDiscount({
      periodMonths: 12,
      originalCents: 94800,
      effectiveCents: 70800,
      monthlyOriginalCents: 9900,
    })
    expect(standardYear.compareOriginalCents).toBe(118800)
    expect(standardYear.savedCents).toBe(48000)
    expect(standardYear.savePercent).toBe(40)
    expect(standardYear.zhFold).toBe('6')

    const proYear = summarizeDiscount({
      periodMonths: 12,
      originalCents: 190800,
      effectiveCents: 142800,
      monthlyOriginalCents: 19900,
    })
    expect(proYear.compareOriginalCents).toBe(238800)
    expect(proYear.savedCents).toBe(96000)
    expect(proYear.savePercent).toBe(40)
    expect(proYear.zhFold).toBe('6')
  })

  it('still reflects bundle savings when yearly has no separate promo discount', () => {
    const bundleOnly = summarizeDiscount({
      periodMonths: 12,
      originalCents: 46800,
      effectiveCents: 46800,
      monthlyOriginalCents: 4900,
    })
    expect(bundleOnly.hasSavings).toBe(true)
    expect(bundleOnly.isPromo).toBe(false)
    expect(bundleOnly.savedCents).toBe(12000)
    expect(bundleOnly.savePercent).toBe(20)
    expect(bundleOnly.zhFold).toBe('8')
  })

  it('suppresses degenerate or zero savings', () => {
    expect(
      summarizeDiscount({
        periodMonths: 1,
        originalCents: 4900,
        effectiveCents: 4900,
        monthlyOriginalCents: 4900,
      }).hasSavings,
    ).toBe(false)
    expect(
      summarizeDiscount({
        periodMonths: 1,
        originalCents: 4900,
        effectiveCents: 4899,
        monthlyOriginalCents: 4900,
      }).hasSavings,
    ).toBe(false)
  })

  it('picks the highest cycle discount across plans for tab badges', () => {
    expect(maxCycleDiscount(LIVE_PLANS, 3)).toEqual({ savePercent: 29, zhFold: '7.1' })
    expect(maxCycleDiscount(LIVE_PLANS, 12)).toEqual({ savePercent: 41, zhFold: '5.9' })
    expect(
      maxCycleDiscount([[{ periodMonths: 12, originalCents: 10000, effectiveCents: 9800 }]], 12),
    ).toBeNull()
  })

  it('computes yearly switch nudge savings only when yearly is cheaper per month', () => {
    expect(yearlyNudgeSavedCents(LIVE_PLANS[0]!, 1)).toBe(24000)
    expect(yearlyNudgeSavedCents(LIVE_PLANS[1]!, 3)).toBe(48000)
    expect(yearlyNudgeSavedCents(LIVE_PLANS[2]!, 12)).toBeNull()
    expect(
      yearlyNudgeSavedCents(
        [
          { periodMonths: 1, originalCents: 4900, effectiveCents: 3900 },
          { periodMonths: 12, originalCents: 58800, effectiveCents: 46800 },
        ],
        1,
      ),
    ).toBeNull()
  })
})

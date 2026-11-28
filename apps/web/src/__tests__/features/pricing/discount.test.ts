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

  it('suppresses zero or inverted savings while keeping real savings on extreme discount ratios', () => {
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
        originalCents: 3900,
        effectiveCents: 4900,
        monthlyOriginalCents: 3900,
      }).hasSavings,
    ).toBe(false)

    const tiny = summarizeDiscount({
      periodMonths: 1,
      originalCents: 4900,
      effectiveCents: 4899,
      monthlyOriginalCents: 4900,
    })
    expect(tiny.hasSavings).toBe(true)
    expect(tiny.savedCents).toBe(1)
    expect(tiny.savePercent).toBeNull()
    expect(tiny.zhFold).toBeNull()

    const nearFree = summarizeDiscount({
      periodMonths: 1,
      originalCents: 10000,
      effectiveCents: 1,
      monthlyOriginalCents: 10000,
    })
    expect(nearFree.hasSavings).toBe(true)
    expect(nearFree.savedCents).toBe(9999)
    expect(nearFree.savePercent).toBeNull()
    expect(nearFree.zhFold).toBeNull()

    const freePromo = summarizeDiscount({
      periodMonths: 1,
      originalCents: 4900,
      effectiveCents: 0,
      monthlyOriginalCents: 4900,
    })
    expect(freePromo.hasSavings).toBe(true)
    expect(freePromo.savedCents).toBe(4900)
    expect(freePromo.savePercent).toBeNull()
    expect(freePromo.zhFold).toBeNull()
  })

  it('keeps zhFold and savePercent mathematically consistent on .5% boundaries and missing monthly prices', () => {
    const halfPercent = summarizeDiscount({
      periodMonths: 1,
      originalCents: 20000,
      effectiveCents: 15900,
      monthlyOriginalCents: 20000,
    })
    expect(halfPercent.savePercent).toBe(21)
    expect(halfPercent.zhFold).toBe('7.9')

    const yearlyHalfPercent = summarizeDiscount({
      periodMonths: 12,
      originalCents: 240000,
      effectiveCents: 142800,
      monthlyOriginalCents: 20000,
    })
    expect(yearlyHalfPercent.savePercent).toBe(41)
    expect(yearlyHalfPercent.zhFold).toBe('5.9')

    const noMonthly = summarizeDiscount({
      periodMonths: 12,
      originalCents: 46800,
      effectiveCents: 34800,
      monthlyOriginalCents: null,
    })
    expect(noMonthly.compareOriginalCents).toBe(46800)
    expect(noMonthly.savedCents).toBe(12000)
    expect(noMonthly.savePercent).toBe(26)
    expect(noMonthly.zhFold).toBe('7.4')

    const nonIntegerYuan = summarizeDiscount({
      periodMonths: 3,
      originalCents: 13500,
      effectiveCents: 10500,
      monthlyOriginalCents: 4990,
    })
    expect(nonIntegerYuan.compareOriginalCents).toBe(14970)
    expect(nonIntegerYuan.monthlyCompareCents).toBe(4990)
    expect(nonIntegerYuan.savedCents).toBe(4470)
  })

  it('picks the highest cycle discount across plans for tab badges', () => {
    expect(maxCycleDiscount(LIVE_PLANS, 3)).toEqual({ savePercent: 29, zhFold: '7.1' })
    expect(maxCycleDiscount(LIVE_PLANS, 12)).toEqual({ savePercent: 41, zhFold: '5.9' })
    expect(
      maxCycleDiscount([[{ periodMonths: 12, originalCents: 10000, effectiveCents: 9800 }]], 12),
    ).toBeNull()
  })

  it('computes incremental yearly switch savings against the current discounted period', () => {
    // 39*12 - 348 = 120 元（12000 分）
    expect(yearlyNudgeSavedCents(LIVE_PLANS[0]!, 1)).toBe(12000)
    // 213*4 - 708 = 144 元（14400 分）
    expect(yearlyNudgeSavedCents(LIVE_PLANS[1]!, 3)).toBe(14400)
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
    // 120*4 - 348 = 132 元（13200 分）
    expect(
      yearlyNudgeSavedCents(
        [
          { periodMonths: 3, originalCents: 13500, effectiveCents: 12000 },
          { periodMonths: 12, originalCents: 46800, effectiveCents: 34800 },
        ],
        3,
      ),
    ).toBe(13200)
  })
})

/**
 * 定价页与工作台购买弹窗共用的折扣计算。
 * 多月周期以「单月原价 × 周期」与「本周期原价」取较大值作基准，确保展示的是相对标准月付的完整优惠。
 */
export interface PriceComparisonInput {
  periodMonths: number
  originalCents: number
  effectiveCents: number
  /** 同方案的单月原价（分）；缺失时回退到本周期原价。 */
  monthlyOriginalCents?: number | null
}

export interface DiscountSummary {
  compareOriginalCents: number
  savedCents: number
  monthlyEffectiveCents: number
  monthlyCompareCents: number
  /** 节省百分比（1..99 的整数）；无有效折扣时为 null。 */
  savePercent: number | null
  /** 中文折数（如 "8"、"7.1"、"6"）；无有效折扣时为 null。 */
  zhFold: string | null
  hasSavings: boolean
  /** 本周期自身是否处于限时优惠（effective < original）。 */
  isPromo: boolean
}

export interface CycleDiscountHighlight {
  savePercent: number
  zhFold: string
}

export function summarizeDiscount(input: PriceComparisonInput): DiscountSummary {
  const periodMonths = Math.max(1, input.periodMonths)
  const monthlyBaselineTotal =
    input.monthlyOriginalCents && input.monthlyOriginalCents > 0
      ? input.monthlyOriginalCents * periodMonths
      : 0
  const compareOriginalCents = Math.max(input.originalCents, monthlyBaselineTotal)
  const savedCents = Math.max(0, compareOriginalCents - input.effectiveCents)
  const monthlyEffectiveCents = input.effectiveCents / periodMonths
  const monthlyCompareCents = compareOriginalCents / periodMonths
  const isPromo = input.effectiveCents < input.originalCents

  if (savedCents <= 0 || compareOriginalCents <= 0) {
    return {
      compareOriginalCents,
      savedCents: 0,
      monthlyEffectiveCents,
      monthlyCompareCents,
      savePercent: null,
      zhFold: null,
      hasSavings: false,
      isPromo,
    }
  }

  const rawPercent = Math.round((savedCents / compareOriginalCents) * 100)
  // 用补数推导折数，避免 .5% 边界两边同时进位导致「6 折 · 省 41%」这类自相矛盾。
  const foldTenths = 100 - rawPercent
  if (rawPercent < 1 || rawPercent > 99 || foldTenths < 1 || foldTenths > 99) {
    return {
      compareOriginalCents,
      savedCents,
      monthlyEffectiveCents,
      monthlyCompareCents,
      savePercent: null,
      zhFold: null,
      hasSavings: false,
      isPromo,
    }
  }

  const zhFold = foldTenths % 10 === 0 ? String(foldTenths / 10) : (foldTenths / 10).toFixed(1)
  return {
    compareOriginalCents,
    savedCents,
    monthlyEffectiveCents,
    monthlyCompareCents,
    savePercent: rawPercent,
    zhFold,
    hasSavings: true,
    isPromo,
  }
}

export interface PlanPeriodPriceEntry {
  periodMonths: number
  originalCents: number
  effectiveCents: number
}

/** 找出某一周期在所有方案里的最高折扣，用于周期切换 Tab 的引导徽标。 */
export function maxCycleDiscount(
  plansPrices: ReadonlyArray<ReadonlyArray<PlanPeriodPriceEntry>>,
  periodMonths: number,
  minSavePercent = 5,
): CycleDiscountHighlight | null {
  let best: CycleDiscountHighlight | null = null
  for (const prices of plansPrices) {
    const target = prices.find((entry) => entry.periodMonths === periodMonths)
    if (!target) continue
    const monthly = prices.find((entry) => entry.periodMonths === 1)
    const summary = summarizeDiscount({
      periodMonths,
      originalCents: target.originalCents,
      effectiveCents: target.effectiveCents,
      monthlyOriginalCents: monthly?.originalCents ?? null,
    })
    if (
      summary.hasSavings &&
      summary.savePercent !== null &&
      summary.zhFold !== null &&
      summary.savePercent >= minSavePercent &&
      (!best || summary.savePercent > best.savePercent)
    ) {
      best = { savePercent: summary.savePercent, zhFold: summary.zhFold }
    }
  }
  return best
}

/** 当前停留在非年付周期时，计算切到年付相对标准月付可省的整年金额（分）。 */
export function yearlyNudgeSavedCents(
  prices: ReadonlyArray<PlanPeriodPriceEntry>,
  currentPeriodMonths: number,
): number | null {
  if (currentPeriodMonths >= 12) return null
  const current = prices.find((entry) => entry.periodMonths === currentPeriodMonths)
  const yearly = prices.find((entry) => entry.periodMonths === 12)
  if (!current || !yearly) return null
  if (yearly.effectiveCents / 12 >= current.effectiveCents / currentPeriodMonths) return null
  const monthly = prices.find((entry) => entry.periodMonths === 1)
  const yearlySummary = summarizeDiscount({
    periodMonths: 12,
    originalCents: yearly.originalCents,
    effectiveCents: yearly.effectiveCents,
    monthlyOriginalCents: monthly?.originalCents ?? null,
  })
  return yearlySummary.hasSavings && yearlySummary.savedCents > 0 ? yearlySummary.savedCents : null
}

/** 四档会员等级。Web 定价面板、账户面板与 Admin 共用同一套分级规则。 */
export type MembershipTier = 'free' | 'basic' | 'plus' | 'max'

/** 套餐目录 → 等级排序表。定价面板、账户面板与 Admin 共用同一把尺子。 */
export function rankedPlanIds(plans: readonly { id: string; monthly_credits: number }[]): string[] {
  return [...plans].sort((a, b) => a.monthly_credits - b.monthly_credits).map((plan) => plan.id)
}

export function tierOf(planId: string | null, ranked: readonly string[]): MembershipTier {
  if (!planId) return 'free'
  const at = ranked.indexOf(planId)
  if (at < 0 || ranked.length <= 1) return 'basic'
  if (at === ranked.length - 1) return 'max'
  return at === 0 ? 'basic' : 'plus'
}

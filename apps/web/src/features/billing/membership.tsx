/** overlay 自己的面板要的完整状态；公开树只拿下面那份收窄过的 view。 */
export interface MembershipState {
  tier: MembershipTier
  planName: string
  expiresLabel: string | null
}

import { formatDate as formatDateOnly } from '../../lib/privateHost'
import type { PrivateMembershipView } from '../../lib/privateOverlay'
import { noActiveSubscriptionLabel } from './billing-display'
import { openBilling, openPricing, useBilling } from './billing-store'
import { tBilling } from './i18n'
import { type MembershipTier, rankedPlanIds, tierOf } from './membership-tier'
import TierBadge, { TIER_COLORS } from './TierBadge'

/** 公开树只画 `PrivateMembershipView`：等级、配色、徽标都在 overlay 这侧定完再递过去。 */
export function useMembershipState(): MembershipState {
  const { account, catalog } = useBilling()
  const subscription = account?.subscription ?? null
  return {
    tier: tierOf(subscription?.plan.id ?? null, rankedPlanIds(catalog?.plans ?? [])),
    planName: subscription?.plan.name ?? noActiveSubscriptionLabel(),
    expiresLabel: subscription ? formatDateOnly(subscription.ends_at) : null,
  }
}

/** 公开树只画 `PrivateMembershipView`：等级、配色、徽标都在 overlay 这侧定完再递过去。 */
export const membership = {
  useMembership(): PrivateMembershipView {
    const { tier, planName, expiresLabel } = useMembershipState()
    const subscribed = tier !== 'free'
    return {
      subscribed,
      label: subscribed ? planName : tBilling('membership.subscribe'),
      accent: TIER_COLORS[tier],
      Badge: ({ size }: { size?: number }) => <TierBadge tier={tier} size={size} />,
      hint: expiresLabel ? tBilling('membership.expires', { date: expiresLabel }) : null,
      open: subscribed ? openBilling : openPricing,
    }
  },
}

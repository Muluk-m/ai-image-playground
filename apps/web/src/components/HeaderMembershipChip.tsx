import { useTranslation } from '../i18n'
import { type PrivateMembershipSlot, PrivateWebMembership } from '../lib/privateOverlay'
import TierBadge, { TIER_COLORS } from './TierBadge'

/**
 * 右上角账号簇里的会员位：已订阅显示等级徽标 + 套餐名，未订阅显示「开通会员」。
 * 数据只来自收费 overlay；没有 overlay 时整个位不渲染（hooks 不会被条件调用）。
 */
function MembershipChip({ slot }: { slot: PrivateMembershipSlot }) {
  const { t } = useTranslation('shell')
  const membership = slot.useMembership()

  if (membership.tier === 'free') {
    return (
      <button
        type="button"
        onClick={membership.openPricing}
        className="studio-generate-button inline-flex h-8 items-center rounded-lg px-3 text-xs font-medium"
      >
        {t('header.membership.subscribe')}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={membership.openAccount}
      title={membership.expiresLabel ?? undefined}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.06] px-2.5 text-xs hover:bg-white/[0.1]"
      style={{ color: TIER_COLORS[membership.tier] }}
    >
      <TierBadge tier={membership.tier} size={14} />
      {membership.planName}
    </button>
  )
}

export default function HeaderMembershipChip() {
  if (!PrivateWebMembership) return null
  return <MembershipChip slot={PrivateWebMembership} />
}

import { type PrivateMembershipSlot, PrivateWebMembership } from '../lib/privateOverlay'

/**
 * 右上角账号簇里的会员位：已订阅显示 overlay 给的徽标 + 套餐名，未订阅显示开通引导。
 * 等级概念不在公开树——这里只按 `PrivateMembershipView` 画，没有 overlay 就整格不渲染
 * （槽位在模块加载时定死，hooks 不会被条件调用）。
 */
function MembershipChip({ slot }: { slot: PrivateMembershipSlot }) {
  const membership = slot.useMembership()
  const { Badge } = membership

  if (!membership.subscribed) {
    return (
      <button
        type="button"
        onClick={membership.open}
        title={membership.hint ?? undefined}
        className="studio-generate-button inline-flex h-8 items-center rounded-lg px-3 text-xs font-medium"
      >
        {membership.label}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={membership.open}
      title={membership.hint ?? undefined}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.06] px-2.5 text-xs hover:bg-white/[0.1]"
      style={{ color: membership.accent }}
    >
      <Badge size={14} />
      {membership.label}
    </button>
  )
}

export default function HeaderMembershipChip() {
  if (!PrivateWebMembership) return null
  return <MembershipChip slot={PrivateWebMembership} />
}

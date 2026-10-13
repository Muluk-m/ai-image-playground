import { type PrivateMembershipSlot, PrivateWebMembership } from '../lib/privateOverlay'
import { Button } from './ui/button'

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
      <Button
        type="button"
        onClick={membership.open}
        title={membership.hint ?? undefined}
        size="sm"
      >
        {membership.label}
      </Button>
    )
  }

  return (
    <Button
      type="button"
      onClick={membership.open}
      title={membership.hint ?? undefined}
      variant="secondary"
      size="sm"
      style={{ color: membership.accent }}
    >
      <Badge size={14} />
      {membership.label}
    </Button>
  )
}

export default function HeaderMembershipChip() {
  if (!PrivateWebMembership) return null
  return <MembershipChip slot={PrivateWebMembership} />
}

import type { HTMLAttributes } from 'react'
import { cn, Icon, type IconName } from '../../lib/privateIcons'
import type { MembershipTier } from './membership-tier'

/** 会员标识与会员卡共用语义色；透明混色由调用方使用 color-mix，避免拼接色值。 */
export const TIER_COLORS: Record<MembershipTier, string> = {
  free: 'hsl(var(--membership-free))',
  basic: 'hsl(var(--membership-basic))',
  plus: 'hsl(var(--membership-plus))',
  max: 'hsl(var(--membership-max))',
}

const TIER_ICONS: Record<MembershipTier, IconName> = {
  free: 'membershipFree',
  basic: 'membershipBasic',
  plus: 'membershipPlus',
  max: 'membershipMax',
}

interface TierBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tier: MembershipTier
  /** 兼容 Admin 既有 SVG 调用；外层 span 与内部装饰图标默认均不进入 tab 顺序。 */
  focusable?: boolean
  /** 兼容既有数字尺寸，归入设计系统的 14 / 16 / 20 / 24 四档。 */
  size?: number
}

/** 用图形与读屏标签共同区分会员等级，不只依赖颜色。 */
export default function TierBadge({
  tier,
  size = 16,
  className,
  style,
  focusable: _focusable,
  ...props
}: TierBadgeProps) {
  const iconSize = size <= 14 ? 'xs' : size <= 16 ? 'sm' : size <= 20 ? 'md' : 'lg'
  return (
    <span
      role="img"
      aria-label={tier}
      {...props}
      className={cn('inline-flex shrink-0 items-center justify-center', className)}
      style={{ color: TIER_COLORS[tier], ...style }}
    >
      <Icon name={TIER_ICONS[tier]} size={iconSize} filled={tier !== 'free'} />
    </span>
  )
}

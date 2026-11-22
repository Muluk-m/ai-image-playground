import type { MembershipTier } from '@image-playground/shared'
import { Crown, Sparkles, Sprout, Star } from 'lucide-react'
import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/** 会员标识与会员卡共用语义色；与 apps/admin/src/styles/tokens.css 的 --membership-* 对齐。 */
export const TIER_COLORS: Record<MembershipTier, string> = {
  free: 'hsl(var(--membership-free))',
  basic: 'hsl(var(--membership-basic))',
  plus: 'hsl(var(--membership-plus))',
  max: 'hsl(var(--membership-max))',
}

const TIER_ICONS = {
  free: Sprout,
  basic: Sparkles,
  plus: Star,
  max: Crown,
} as const

interface TierBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tier: MembershipTier
  focusable?: boolean
  size?: number
}

export default function TierBadge({
  tier,
  size = 16,
  className,
  style,
  focusable: _focusable,
  ...props
}: TierBadgeProps) {
  const Glyph = TIER_ICONS[tier]
  return (
    <span
      role="img"
      aria-label={tier}
      {...props}
      className={cn('inline-flex shrink-0 items-center justify-center', className)}
      style={{ color: TIER_COLORS[tier], ...style }}
    >
      <Glyph
        size={size}
        aria-hidden="true"
        fill={tier === 'free' ? 'none' : 'currentColor'}
        fillOpacity={tier === 'free' ? undefined : 0.25}
      />
    </span>
  )
}

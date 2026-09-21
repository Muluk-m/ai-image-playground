import type { SVGProps } from 'react'
import type { PrivateMembershipTier } from '../lib/privateOverlay'

/**
 * 四档等级的主色。私有 overlay 的会员卡与定价卡都按它上色（徽标、渐变底、强调字），
 * 放在公开树是为了两处共用同一组值——各写一套会在同一屏里出现两种「Plus 蓝」。
 *
 * 取值走十六进制而不是 CSS 变量：overlay 会把它拼进 `linear-gradient(...${color}22)`
 * 这类带透明度后缀的字符串，变量在那里拼不出颜色。
 */
export const TIER_COLORS: Record<PrivateMembershipTier, string> = {
  free: '#94a3b8',
  basic: '#38bdf8',
  plus: '#8b5cf6',
  max: '#f59e0b',
}

interface TierBadgeProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  tier: PrivateMembershipTier
  /** 边长（像素）。徽标是正方形，宽高同取这个值。 */
  size?: number
}

/**
 * 等级徽标：一枚按等级上色的盾。档位越高里面的星越多，颜色之外再给一层不依赖色觉的区分
 * ——会员卡上它与同色的文字挨着，只靠颜色区分对色弱用户等于没区分。
 */
export default function TierBadge({ tier, size = 16, ...props }: TierBadgeProps) {
  const color = TIER_COLORS[tier]
  const pips = { free: 0, basic: 1, plus: 2, max: 3 }[tier]
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label={tier}
      {...props}
    >
      <path
        d="M12 2.5 20 5.5v6.2c0 4.6-3.2 8.3-8 9.8-4.8-1.5-8-5.2-8-9.8V5.5z"
        fill={color}
        fillOpacity={0.18}
        stroke={color}
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
      {Array.from({ length: pips }, (_, index) => (
        <circle
          key={index}
          cx={12 + (index - (pips - 1) / 2) * 4.2}
          cy={11.5}
          r={1.5}
          fill={color}
        />
      ))}
    </svg>
  )
}

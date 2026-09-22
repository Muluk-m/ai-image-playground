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
  free: '#9aa4a0',
  basic: '#8fe06a',
  plus: '#4fd2e8',
  max: '#f2c75c',
}

interface TierBadgeProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  tier: PrivateMembershipTier
  /** 边长（像素）。徽标是正方形，宽高同取这个值。 */
  size?: number
}

/**
 * 等级徽标：一套同构的圆环线描，环内换芯——free 单叶、basic 双叶、plus 星芒、max 皇冠。
 * 形状本身就带档位递进，颜色之外再给一层不依赖色觉的区分：徽标常和同色文字挨着，
 * 只靠颜色区分对色弱用户等于没区分。
 */
export default function TierBadge({ tier, size = 16, ...props }: TierBadgeProps) {
  const color = TIER_COLORS[tier]
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
      <circle cx="12" cy="12" r="10" stroke={color} strokeWidth="1.4" />
      {(tier === 'basic' || tier === 'plus') && (
        <circle cx="12" cy="12" r="7.6" stroke={color} strokeWidth="1" opacity="0.7" />
      )}
      {tier === 'free' && (
        <path
          d="M12 16.5V11m0 0c0-2 1.4-3.5 3.2-3.9C15.4 9 14.2 11 12 11Z"
          stroke={color}
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      )}
      {tier === 'basic' && (
        <>
          <path
            d="M11.2 16v-3.6c0-1.8-1-3-2.6-3.4.1 1.8 1.1 3.4 2.6 3.9"
            stroke={color}
            strokeWidth="1.3"
            strokeLinecap="round"
          />
          <path
            d="M12.8 16v-3.6c0-1.8 1-3 2.6-3.4-.1 1.8-1.1 3.4-2.6 3.9"
            stroke={color}
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </>
      )}
      {tier === 'plus' && (
        <path
          d="M12 7.6v8.8M7.6 12h8.8M9 9l6 6M15 9l-6 6"
          stroke={color}
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      )}
      {tier === 'max' && (
        <path
          d="M7.5 15.4h9l.9-5.4-3 2-2.4-3.4-2.4 3.4-3-2 .9 5.4Z"
          stroke={color}
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      )}
    </svg>
  )
}

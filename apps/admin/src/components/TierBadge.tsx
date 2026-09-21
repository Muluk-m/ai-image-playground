/** 会员等级徽标：与 web 端 `apps/web/src/components/TierBadge.tsx` 同一套画法（两个应用不共享 React 包，改动要同步）。
 * 圆环线性一套四档。颜色是固定品牌色，不跟主题反色（金/青在浅色底也认得出）。 */
export type MemberTier = 'free' | 'basic' | 'plus' | 'max'

export const TIER_COLORS: Record<MemberTier, string> = {
  free: '#9aa4a0',
  basic: '#8fe06a',
  plus: '#4fd2e8',
  max: '#f2c75c',
}

export default function TierBadge({ tier, size = 14 }: { tier: MemberTier; size?: number }) {
  const color = TIER_COLORS[tier]
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke={color} strokeWidth="1.4" />
      {tier === 'basic' || tier === 'plus' ? (
        <circle cx="12" cy="12" r="7.6" stroke={color} strokeWidth="1" opacity="0.7" />
      ) : null}
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

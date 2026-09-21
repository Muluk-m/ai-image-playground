import { ArrowRight, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'

/** throwaway：会员等级徽标（两种画法）+ 侧栏账号卡四种状态的 demo。纯 SVG，不用位图。 */

type Tier = 'free' | 'basic' | 'plus' | 'max'

const TIERS: { id: Tier; label: string; color: string }[] = [
  { id: 'free', label: '免费', color: '#9aa4a0' },
  { id: 'basic', label: '基础会员', color: '#8fe06a' },
  { id: 'plus', label: '高级会员', color: '#4fd2e8' },
  { id: 'max', label: '至尊会员', color: '#f2c75c' },
]

/** 画法 ①：圆环线性——灰叶 / 双叶 / 星芒 / 皇冠。 */
function LineBadge({ tier, color, size = 20 }: { tier: Tier; color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke={color} strokeWidth="1.4" />
      {tier !== 'free' && tier !== 'max' && (
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

/** 画法 ②：实心盾 + 嫩芽，颜色分档。 */
function ShieldBadge({ tier, color, size = 20 }: { tier: Tier; color: string; size?: number }) {
  const id = `sg-${tier}`
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffffff" stopOpacity="0.9" />
          <stop offset="1" stopColor={color} />
        </linearGradient>
      </defs>
      <path
        d="M12 2.8 19 5v7.1c0 4.2-2.9 7.3-7 9.1-4.1-1.8-7-4.9-7-9.1V5l7-2.2Z"
        fill={`url(#${id})`}
        opacity={tier === 'free' ? 0.55 : 1}
      />
      <path
        d="M12 16.4v-4.2m0 0c0-1.9 1.3-3.2 3-3.6.1 1.8-1.1 3.5-3 3.6Zm0 0c0-1.9-1.3-3.2-3-3.6-.1 1.8 1.1 3.5 3 3.6Z"
        stroke="#10231a"
        strokeWidth="1.2"
        strokeLinecap="round"
        opacity="0.75"
      />
    </svg>
  )
}

function AccountCard({ tier, style }: { tier: Tier; style: 'line' | 'shield' }) {
  const meta = TIERS.find((one) => one.id === tier)!
  const Badge = style === 'line' ? LineBadge : ShieldBadge
  const isFree = tier === 'free'
  const canUpgrade = tier === 'basic' || tier === 'plus'
  return (
    <div style={{ width: 208 }} className="rounded-2xl border border-border bg-sidebar p-2.5">
      <div className="flex items-center gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary/15 text-sm font-semibold text-primary ring-1 ring-primary/30">
          幕
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium">幕芽用户</p>
          <p className="mt-0.5 flex items-center gap-1 text-[11px]" style={{ color: meta.color }}>
            <Badge tier={tier} color={meta.color} size={14} />
            {meta.label}
          </p>
        </div>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </div>
      {isFree && (
        <button
          type="button"
          className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-[12px] font-medium text-black"
          style={{
            background: 'linear-gradient(135deg, #d9ffba, #93e46f 55%, #63c455)',
            boxShadow: '0 10px 26px -14px rgba(147,228,111,0.9)',
          }}
        >
          开通会员
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      )}
      {canUpgrade && (
        <button
          type="button"
          className="mt-2.5 flex w-full items-center justify-between rounded-xl border border-border px-3 py-2 text-[12px] text-muted-foreground hover:border-primary/60 hover:text-foreground"
        >
          <span>升级会员</span>
          <span className="text-[11px] opacity-70">本月额度 1,240 / 2,000</span>
        </button>
      )}
      {tier === 'max' && (
        <p className="mt-2 px-1 text-[11px] text-muted-foreground">到期 2027-03-01 · 自动续费</p>
      )}
    </div>
  )
}

export default function VipDemo() {
  const [style, setStyle] = useState<'line' | 'shield'>('line')
  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <div className="flex items-center gap-3 pb-6">
        <h1 className="text-lg font-semibold">会员等级徽标 + 账号卡</h1>
        <div className="ml-auto flex gap-1.5">
          {(['line', 'shield'] as const).map((one) => (
            <button
              key={one}
              type="button"
              onClick={() => setStyle(one)}
              className={`rounded-full px-3 py-1 text-xs ${
                style === one
                  ? 'bg-primary font-medium text-primary-foreground'
                  : 'border border-border text-muted-foreground'
              }`}
            >
              {one === 'line' ? '① 圆环线性' : '② 实心盾牌'}
            </button>
          ))}
        </div>
      </div>

      <h2 className="pb-3 text-sm font-semibold">徽标本体（14 / 20 / 32 / 48px）</h2>
      <div className="flex flex-wrap gap-6 rounded-2xl border border-border p-5">
        {TIERS.map((one) => (
          <div key={one.id} className="flex flex-col items-center gap-2">
            <div className="flex items-end gap-3">
              {[14, 20, 32, 48].map((size) =>
                style === 'line' ? (
                  <LineBadge key={size} tier={one.id} color={one.color} size={size} />
                ) : (
                  <ShieldBadge key={size} tier={one.id} color={one.color} size={size} />
                ),
              )}
            </div>
            <span className="text-[11px]" style={{ color: one.color }}>
              {one.label}
            </span>
          </div>
        ))}
      </div>

      <h2 className="pb-3 pt-8 text-sm font-semibold">侧栏账号卡四种状态</h2>
      <div className="flex flex-wrap gap-4">
        {TIERS.map((one) => (
          <div key={one.id} className="flex flex-col gap-2">
            <AccountCard tier={one.id} style={style} />
            <span className="px-1 text-[11px] text-muted-foreground">
              {one.id === 'free'
                ? '非会员：整条「开通会员」引导'
                : one.id === 'max'
                  ? '顶档：不再劝，显示到期'
                  : '有会员：一行「升级」+ 本月额度'}
            </span>
          </div>
        ))}
      </div>

      <h2 className="pb-3 pt-8 text-sm font-semibold">积分胶囊旁的小徽标（20px 实况）</h2>
      <div className="flex items-center gap-2 rounded-2xl border border-border p-5">
        <span className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.06] px-2.5 text-xs tabular-nums">
          ⚡ 583,006
        </span>
        <span className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.06] px-2.5 text-xs">
          {style === 'line' ? (
            <LineBadge tier="plus" color="#4fd2e8" size={16} />
          ) : (
            <ShieldBadge tier="plus" color="#4fd2e8" size={16} />
          )}
          高级会员
        </span>
        <span className="grid h-8 w-8 place-items-center rounded-full bg-primary/20 text-xs">
          幕
        </span>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<VipDemo />)

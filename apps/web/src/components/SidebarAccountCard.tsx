import { useTranslation } from '../i18n'
import { PrivateWebMembership } from '../lib/privateOverlay'
import { useStore } from '../store'
import TierBadge, { type MemberTier, TIER_COLORS } from './TierBadge'

/**
 * 侧栏左下角的账号卡：头像 + 昵称 + 会员等级徽标，以及按等级给的引导：
 * 非会员一条「开通会员」，有会员一行「升级会员」，顶档只显示到期日（不再劝）。
 *
 * 等级与余额由收费 overlay 提供（`PrivateWebMembership`）。没有 overlay 的部署只剩头像与昵称，
 * 不编造等级。
 */
export default function SidebarAccountCard({ username }: { username: string | null }) {
  const { t } = useTranslation('shell')
  const setShowSettings = useStore((state) => state.setShowSettings)
  const membership = PrivateWebMembership?.useMembership()
  const name = username?.trim() || t('account.guest')
  const avatarLabel = Array.from(name)[0]?.toUpperCase() ?? 'U'
  const tier: MemberTier = membership?.tier ?? 'free'
  const open = () => (membership ? membership.openAccount() : setShowSettings(true))

  return (
    <div className="mt-auto rounded-2xl border border-border p-2.5">
      <button type="button" onClick={open} className="flex w-full items-center gap-2.5 text-left">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary/15 text-sm font-semibold text-primary ring-1 ring-primary/30">
          {avatarLabel}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-foreground">{name}</span>
          {membership ? (
            <span
              className="mt-0.5 flex items-center gap-1 text-[11px]"
              style={{ color: TIER_COLORS[tier] }}
            >
              <TierBadge tier={tier} />
              {membership.planName}
            </span>
          ) : null}
        </span>
        <span aria-hidden="true" className="shrink-0 text-muted-foreground">
          ›
        </span>
      </button>

      {membership && tier === 'free' && (
        <button
          type="button"
          onClick={membership.openPricing}
          className="studio-generate-button mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-[12px] font-medium"
        >
          {t('account.subscribe')} →
        </button>
      )}
      {membership && (tier === 'basic' || tier === 'plus') && (
        <button
          type="button"
          onClick={membership.openPricing}
          className="mt-2.5 flex w-full items-center justify-between gap-3 rounded-xl border border-border px-3 py-2 text-[12px] text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground"
        >
          <span className="shrink-0">{t('account.upgrade')}</span>
          <span className="truncate text-[11px] opacity-70">{membership.balanceLabel}</span>
        </button>
      )}
      {membership && tier === 'max' && membership.expiresLabel && (
        <p className="mt-2 px-1 text-[11px] text-muted-foreground">
          {t('account.expires', { date: membership.expiresLabel })}
        </p>
      )}
    </div>
  )
}

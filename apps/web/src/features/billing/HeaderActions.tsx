import { type ReactNode, useEffect, useRef, useState } from 'react'
import {
  BRAND_WORDMARK,
  Button,
  brandNeedsWordmark,
  ContactDialog,
  DisplaySettingsMenuItems,
  Icon,
  type IconName,
  isClientCapabilityEnabled,
  isInFloatingLayer,
} from '../../lib/privateHost'
import type { PrivateHeaderActionsProps } from '../../lib/privateOverlay'
import { AccountAvatar } from './AccountAvatar'
import { AccountPanel, type AccountView, CreditIcon } from './AccountPanel'
import { noActiveSubscriptionLabel } from './billing-display'
import {
  availableCredits,
  consumePendingBillingModal,
  formatCredits,
  OPEN_BILLING_EVENT,
  OPEN_PRICING_EVENT,
  OPEN_RECHARGE_EVENT,
  openBilling,
  useBilling,
} from './billing-store'
import { tBilling, useTranslation } from './i18n'
import { useMembershipState } from './membership'
import type { MembershipTier } from './membership-tier'
import { PricingPanel, RechargePanel } from './PurchasePanels'
import { clearAccountProfile, loadAccountProfile, useAccountProfile } from './profile-store'
import TierBadge, { TIER_COLORS } from './TierBadge'

export function HeaderCreditAction() {
  const enabled = isClientCapabilityEnabled('billing:credits')
  const { account } = useBilling()
  const { tier } = useMembershipState()
  useTranslation()
  if (!enabled || account?.access_state === 'access_denied' || account?.unmetered?.enabled)
    return null
  const total = availableCredits(account)
  return (
    <Button
      type="button"
      onClick={openBilling}
      aria-label={tBilling('header.creditsAria', {
        amount:
          total === null
            ? tBilling('header.creditsLoading')
            : tBilling('header.creditsAmount', { count: total, n: formatCredits(total) }),
      })}
      variant="secondary"
      size="sm"
      className="hidden tabular-nums sm:inline-flex"
    >
      <CreditIcon className="h-3.5 w-3.5" style={{ color: TIER_COLORS[tier] }} />
      {total === null ? '—' : formatCredits(total)}
    </Button>
  )
}

function AccountMenuRow({
  icon,
  label,
  trailing,
  onClick,
}: {
  icon: IconName
  label: string
  trailing?: ReactNode
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      role="menuitem"
      onClick={onClick}
      variant="ghost"
      className="h-11 w-full justify-start gap-3 px-2 text-sm font-normal text-foreground"
    >
      <Icon name={icon} className="text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {trailing}
      <Icon name="chevronRight" className="text-muted-foreground" />
    </Button>
  )
}

/** 有套餐时入口写「续费套餐」，未开通写「开通会员」。换档在套餐弹窗里下单，下一周期再生效。 */
function planActionKey(tier: MembershipTier): 'membership.subscribe' | 'action.renewPlan' {
  return tier === 'free' ? 'membership.subscribe' : 'action.renewPlan'
}

export function HeaderActions({
  username,
  loggingOut,
  syncPending,
  onOpenSettings,
  onLogout,
}: PrivateHeaderActionsProps) {
  const enabled = isClientCapabilityEnabled('billing:credits')
  const { account } = useBilling()
  const billingVisible =
    enabled && account?.access_state !== 'access_denied' && !account?.unmetered?.enabled
  const { t: tShell } = useTranslation('shell')
  const [menuOpen, setMenuOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [accountView, setAccountView] = useState<AccountView>('overview')
  const [pricingOpen, setPricingOpen] = useState(false)
  const [rechargeOpen, setRechargeOpen] = useState(false)
  const [contactOpen, setContactOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const total = availableCredits(account)
  const planName = account?.subscription?.plan.name ?? noActiveSubscriptionLabel()
  const membershipState = useMembershipState()
  const tier = membershipState.tier
  const expiresLabel = membershipState.expiresLabel
  const { profile } = useAccountProfile()
  const displayName =
    profile?.nickname?.trim() ||
    username ||
    `${tShell('header.brandName')}${brandNeedsWordmark() ? ` ${BRAND_WORDMARK}` : ''}`
  const syncDot = syncPending ? (
    <span
      role="img"
      aria-label={tBilling('header.syncPending')}
      className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
    />
  ) : null

  useEffect(() => {
    if (!enabled) return
    const listener = () => {
      setMenuOpen(false)
      setPricingOpen(false)
      setRechargeOpen(false)
      setAccountView('overview')
      setAccountOpen(true)
    }
    window.addEventListener(OPEN_BILLING_EVENT, listener)
    return () => window.removeEventListener(OPEN_BILLING_EVENT, listener)
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    const listener = () => {
      setMenuOpen(false)
      setAccountOpen(false)
      setPricingOpen(false)
      setRechargeOpen(true)
    }
    window.addEventListener(OPEN_RECHARGE_EVENT, listener)
    return () => window.removeEventListener(OPEN_RECHARGE_EVENT, listener)
  }, [enabled])

  // 侧栏账号卡里的「开通 / 升级会员」也落到这一套面板，不另开一份。
  useEffect(() => {
    if (!enabled) return
    const listener = () => {
      setMenuOpen(false)
      setAccountOpen(false)
      setRechargeOpen(false)
      setPricingOpen(true)
    }
    window.addEventListener(OPEN_PRICING_EVENT, listener)
    return () => window.removeEventListener(OPEN_PRICING_EVENT, listener)
  }, [enabled])

  useEffect(() => {
    if (!enabled || !username) return
    const pending = consumePendingBillingModal()
    if (pending === 'pricing') {
      setMenuOpen(false)
      setAccountOpen(false)
      setRechargeOpen(false)
      setPricingOpen(true)
    } else if (pending === 'recharge') {
      setMenuOpen(false)
      setAccountOpen(false)
      setPricingOpen(false)
      setRechargeOpen(true)
    }
  }, [enabled, username])

  useEffect(() => {
    if (!menuOpen) return
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (isInFloatingLayer(event.target)) return
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
      rootRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])

  useEffect(() => {
    if (!username) {
      clearAccountProfile()
      return
    }
    void loadAccountProfile()
  }, [username])

  // 绑定回跳只回到工作台，账户设置页自己读回跳参数。
  useEffect(() => {
    const params = new URL(window.location.href).searchParams
    if (!params.has('auth_link') && !params.has('auth_link_error')) return
    setMenuOpen(false)
    setAccountView('settings')
    setAccountOpen(true)
  }, [])

  const openAccount = (view: AccountView) => {
    setMenuOpen(false)
    setPricingOpen(false)
    setRechargeOpen(false)
    setAccountView(view)
    setAccountOpen(true)
  }
  const openPricing = () => {
    setMenuOpen(false)
    setAccountOpen(false)
    setRechargeOpen(false)
    setPricingOpen(true)
  }
  const openRecharge = () => {
    setMenuOpen(false)
    setAccountOpen(false)
    setPricingOpen(false)
    setRechargeOpen(true)
  }
  const settingsRow = {
    id: 'settings',
    label: tBilling('nav.settings'),
    icon: 'security' as IconName,
    onClick: () => openAccount('settings'),
  }
  const rows: Array<{
    id: string
    label: string
    icon: IconName
    onClick: () => void
  }> = billingVisible
    ? [
        {
          id: 'overview',
          label: tBilling('nav.overview'),
          icon: 'user',
          onClick: () => openAccount('overview'),
        },
        settingsRow,
        {
          id: 'billing',
          label: tBilling('nav.billing'),
          icon: 'list',
          onClick: () => openAccount('billing'),
        },
        {
          id: 'referrals',
          label: tBilling('nav.referrals'),
          icon: 'share',
          onClick: () => openAccount('referrals'),
        },
      ]
    : username
      ? [settingsRow]
      : []

  return (
    <>
      <div ref={rootRef} className="relative">
        <Button
          type="button"
          onClick={() => setMenuOpen((current) => !current)}
          aria-label={tBilling(username ? 'header.openAccount' : 'header.openMenu')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          variant="ghost"
          size="icon-sm"
          className="relative"
        >
          <AccountAvatar src={profile?.avatarUrl ?? null} />
          {syncPending ? (
            <span
              role="img"
              aria-label={tBilling('header.syncPending')}
              className="absolute right-0 top-0 h-2 w-2 rounded-full bg-warning ring-2 ring-background"
            />
          ) : null}
        </Button>

        {menuOpen ? (
          <div
            role="menu"
            className="absolute right-0 top-[calc(100%+0.75rem)] z-50 max-h-[calc(100dvh-5rem)] w-[400px] max-w-[calc(100vw-1.5rem)] overflow-y-auto overscroll-contain rounded-2xl border border-border bg-card p-4 text-foreground shadow-popover"
          >
            <div className="flex items-center gap-3">
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                <AccountAvatar src={profile?.avatarUrl ?? null} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-title font-semibold">{displayName}</div>
                {billingVisible ? (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {expiresLabel
                      ? tBilling('account.validUntil', { date: expiresLabel })
                      : tBilling('account.noActivePlanHint')}
                  </div>
                ) : null}
              </div>
              {billingVisible ? (
                <span
                  className="inline-flex max-w-[46%] shrink-0 items-center gap-1 rounded-full border border-border bg-muted px-2 py-1 text-xs font-medium"
                  style={{ color: TIER_COLORS[tier] }}
                >
                  <TierBadge tier={tier} size={14} />
                  <span className="truncate">
                    {tier === 'free' ? noActiveSubscriptionLabel() : planName}
                  </span>
                </span>
              ) : null}
            </div>

            {billingVisible ? (
              <div className="mt-4 rounded-xl border border-border bg-muted/40 p-3.5">
                <div className="text-xs text-muted-foreground">
                  {tBilling('account.creditBalance')}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <CreditIcon className="h-5 w-5" style={{ color: TIER_COLORS[tier] }} />
                    <span className="truncate text-headline font-semibold tracking-tight tabular-nums">
                      {total === null ? '—' : formatCredits(total)}
                    </span>
                  </div>
                  <Button
                    type="button"
                    onClick={openRecharge}
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                  >
                    <Icon name="add" />
                    {tBilling('action.topUp')}
                  </Button>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>{tBilling('account.subscriptionFirst')}</span>
                  <span className="shrink-0">
                    {expiresLabel
                      ? tBilling('account.validUntil', { date: expiresLabel })
                      : tBilling('account.noActivePlanHint')}
                  </span>
                </div>
                <Button type="button" onClick={openPricing} className="mt-3 h-11 w-full rounded-lg">
                  <Icon name="quality" />
                  {tBilling(planActionKey(tier))}
                </Button>
              </div>
            ) : null}

            {rows.length > 0 ? (
              <div className="mt-2">
                {rows.map((row) => (
                  <AccountMenuRow
                    key={row.id}
                    icon={row.icon}
                    label={row.label}
                    onClick={row.onClick}
                  />
                ))}
              </div>
            ) : null}

            <div className="my-2 h-px bg-border" />
            {/* 套餐在上面的余额卡，条款在底栏。语言只留顶栏地球。主题用公开的三段开关。 */}
            <DisplaySettingsMenuItems
              itemClassName="w-full px-2"
              iconClassName="h-4 w-4"
              showPlans={false}
              showLanguage={false}
              showLegal={false}
            />
            <AccountMenuRow
              icon="settings"
              label={tBilling('action.settings')}
              trailing={syncDot}
              onClick={() => {
                setMenuOpen(false)
                onOpenSettings()
              }}
            />
            {/* 与公开顶栏同一个「联系我们」弹窗，只给邮箱。 */}
            <AccountMenuRow
              icon="chat"
              label={tShell('header.contact.menu')}
              onClick={() => {
                setMenuOpen(false)
                setContactOpen(true)
              }}
            />

            <div className="mt-2 flex items-center justify-between gap-3 border-t border-border px-2 pt-3">
              <div className="flex min-w-0 items-center gap-1.5 text-label-sm text-muted-foreground">
                <a href="/terms" target="_blank" rel="noopener" className="hover:text-foreground">
                  {tShell('nav.terms')}
                </a>
                <span aria-hidden="true">·</span>
                <a href="/privacy" target="_blank" rel="noopener" className="hover:text-foreground">
                  {tShell('nav.privacy')}
                </a>
              </div>
              {username ? (
                <Button
                  type="button"
                  role="menuitem"
                  disabled={loggingOut}
                  onClick={() => {
                    setMenuOpen(false)
                    onLogout()
                  }}
                  variant="ghost"
                  size="sm"
                  className="shrink-0 px-2 font-normal text-muted-foreground disabled:cursor-wait"
                >
                  <Icon name="logout" />
                  {tBilling(loggingOut ? 'action.loggingOut' : 'action.logout')}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {accountOpen ? (
        <AccountPanel
          username={username}
          initialView={accountView}
          onClose={() => setAccountOpen(false)}
          onOpenPricing={openPricing}
          onOpenRecharge={openRecharge}
          onAccountDeleted={() => {
            setAccountOpen(false)
            window.location.assign('/')
          }}
        />
      ) : null}
      {pricingOpen ? <PricingPanel onClose={() => setPricingOpen(false)} /> : null}
      {rechargeOpen ? <RechargePanel onClose={() => setRechargeOpen(false)} /> : null}
      {contactOpen ? <ContactDialog onClose={() => setContactOpen(false)} /> : null}
    </>
  )
}

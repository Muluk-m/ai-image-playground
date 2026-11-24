import type { LedgerEntry, LedgerPage } from '@image-playground/shared'
import type { CSSProperties } from 'react'
import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  cn,
  Icon,
  type IconName,
  isClientCapabilityEnabled,
  Overlay,
} from '../../lib/privateHost'
import { AccountAvatar } from './AccountAvatar'
import { AccountSettings } from './AccountSettings'
import { ActivitySection } from './ActivityHeatGraph'
import {
  noActiveSubscriptionLabel,
  toUserBillingEntries,
  userBillingEntryDescription,
  userBillingEntryTitle,
} from './billing-display'
import {
  approximateImages,
  availableCredits,
  formatCredits,
  formatDate,
  friendlyBillingError,
  loadBilling,
  readBillingJson,
  useBilling,
} from './billing-store'
import { type BillingKey, tBilling, useTranslation } from './i18n'
import { loadAccountProfile, useAccountProfile } from './profile-store'
import { ReferralPanel } from './ReferralPanel'
import { useMediaQuery } from './useMediaQuery'

export function CreditIcon({ className, style }: { className: string; style?: CSSProperties }) {
  return (
    <span className={cn('inline-flex shrink-0', className)} style={style} aria-hidden="true">
      <Icon name="credits" className="h-full w-full" />
    </span>
  )
}

export type AccountView = 'overview' | 'billing' | 'referrals' | 'settings'

/** 方案 B 侧栏。账户设置排在概览后面，图标用 security。 */
export const accountNavItems = [
  ['overview', 'nav.overview', 'user'],
  ['settings', 'nav.settings', 'security'],
  ['billing', 'nav.billing', 'list'],
  ['referrals', 'nav.referrals', 'share'],
] as const satisfies ReadonlyArray<readonly [AccountView, BillingKey, IconName]>

function viewTitle(view: AccountView): BillingKey {
  if (view === 'overview') return 'nav.overview'
  if (view === 'settings') return 'nav.settings'
  if (view === 'referrals') return 'nav.referrals'
  return 'nav.billing'
}

function CreditCard({
  label,
  value,
  footnote,
}: {
  label: string
  value: number
  footnote: string
}) {
  return (
    <div className="rounded-2xl border border-border bg-muted p-4">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-2 text-headline font-semibold tracking-tight text-foreground">
        {formatCredits(value)}
      </div>
      <div className="mt-1 text-label-sm text-muted-foreground">{footnote}</div>
    </div>
  )
}

export function AccountPanel({
  username,
  initialView,
  onClose,
  onOpenPricing,
  onOpenRecharge,
  onAccountDeleted,
}: {
  username: string | null
  initialView: AccountView
  onClose: () => void
  onOpenPricing: () => void
  onOpenRecharge: () => void
  onAccountDeleted: () => void
}) {
  useTranslation()
  const mobile = useMediaQuery('(max-width: 767px)')
  const { profile } = useAccountProfile()
  const displayName = profile?.nickname?.trim() || username || tBilling('account.fallbackName')
  const { status, account, error } = useBilling()
  const credits = account?.account
  const [view, setView] = useState<AccountView>(initialView)
  const [billingEntries, setBillingEntries] = useState<LedgerEntry[]>([])
  const [nextLedgerOffset, setNextLedgerOffset] = useState<number | null>(null)
  const [ledgerLoading, setLedgerLoading] = useState(false)
  const [ledgerError, setLedgerError] = useState(false)
  const [referralRefresh, setReferralRefresh] = useState(0)
  const visibleBillingEntries = useMemo(
    () => toUserBillingEntries(billingEntries),
    [billingEntries],
  )
  const total = availableCredits(account)
  const billingEnabled = isClientCapabilityEnabled('billing:credits')
  const billingVisible =
    billingEnabled &&
    account?.access_state !== 'access_denied' &&
    account?.unmetered?.enabled !== true
  const overviewVisible = billingVisible || (billingEnabled && account?.unmetered?.enabled === true)
  const activeView: AccountView =
    (view === 'billing' || view === 'referrals') && !billingVisible
      ? 'settings'
      : view === 'overview' && !overviewVisible
        ? 'settings'
        : view
  const availableImages =
    account && total !== null ? approximateImages(total, account.model_prices) : null
  const planName = account?.subscription?.plan.name ?? noActiveSubscriptionLabel()
  const mobileSettings = mobile && activeView === 'settings'

  useEffect(() => {
    if (!account) return
    setBillingEntries(account.ledger)
    setNextLedgerOffset(account.ledger.length === 100 ? 100 : null)
    setLedgerError(false)
  }, [account])

  async function loadOlderBillingEntries(): Promise<void> {
    if (nextLedgerOffset === null || ledgerLoading) return
    setLedgerLoading(true)
    setLedgerError(false)
    try {
      const page: LedgerPage = await readBillingJson<LedgerPage>(
        `/api/billing/ledger?offset=${nextLedgerOffset}&limit=100`,
      )
      setBillingEntries((current) => [...current, ...page.ledger])
      setNextLedgerOffset(page.next_offset)
    } catch {
      setLedgerError(true)
    } finally {
      setLedgerLoading(false)
    }
  }

  return (
    <Overlay
      onClose={onClose}
      role="none"
      layout={mobileSettings ? 'fill' : 'center'}
      backdrop={mobileSettings ? 'none' : 'dim'}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-panel-title"
        className={
          mobileSettings
            ? 'flex h-dvh w-full flex-col bg-background text-foreground'
            : 'flex h-[min(720px,calc(100dvh-2rem))] w-[min(1040px,calc(100vw-2rem))] overflow-hidden rounded-3xl border border-border bg-card text-foreground shadow-dialog'
        }
      >
        <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-muted p-4 md:flex">
          <div className="flex items-center gap-3 rounded-2xl px-2 py-3">
            <div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full bg-primary text-sm font-semibold text-primary-foreground">
              <AccountAvatar src={profile?.avatarUrl ?? null} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-foreground">{displayName}</div>
              {billingVisible ? (
                <div className="mt-0.5 text-xs text-muted-foreground">{planName}</div>
              ) : null}
            </div>
          </div>

          <nav className="mt-6 space-y-1" aria-label={tBilling('account.navAria')}>
            {accountNavItems
              .filter(
                ([value]) =>
                  value === 'settings' ||
                  (value === 'overview' && overviewVisible) ||
                  billingVisible,
              )
              .map(([value, labelKey, icon]) => (
                <Button
                  variant="ghost"
                  size="default"
                  key={value}
                  type="button"
                  onClick={() => setView(value)}
                  aria-current={activeView === value ? 'page' : undefined}
                  className={`w-full justify-start gap-3 text-left ${
                    activeView === value
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <span
                    className={`grid h-6 w-6 place-items-center rounded-md ${
                      activeView === value ? 'bg-primary/10 text-primary' : 'bg-muted'
                    }`}
                    aria-hidden="true"
                  >
                    <Icon name={icon} filled={activeView === value} />
                  </span>
                  <span className="text-sm font-medium">{tBilling(labelKey)}</span>
                </Button>
              ))}
          </nav>

          {billingVisible ? (
            <div className="mt-auto space-y-2">
              <Button size="default" type="button" onClick={onOpenPricing} className="w-full">
                {tBilling('action.subscribe')}
              </Button>
              <Button
                variant="outline"
                size="default"
                type="button"
                onClick={onOpenRecharge}
                className="w-full"
              >
                {tBilling('action.recharge')}
              </Button>
            </div>
          ) : null}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          {mobileSettings ? (
            <header className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-3">
              <Button
                variant="ghost"
                size="icon-sm"
                type="button"
                aria-label={tBilling('settings.back')}
                onClick={() => {
                  if (overviewVisible) setView('overview')
                  else onClose()
                }}
              >
                <Icon name="back" />
              </Button>
              <h2
                id="account-panel-title"
                className="text-xl font-semibold tracking-tight text-foreground"
              >
                {tBilling('nav.settings')}
              </h2>
            </header>
          ) : (
            <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-4 sm:px-6">
              <div>
                <h2
                  id="account-panel-title"
                  className="mt-1 text-xl font-semibold tracking-tight text-foreground"
                >
                  {tBilling(viewTitle(activeView))}
                </h2>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={status === 'loading'}
                  onClick={() => {
                    if (billingEnabled) {
                      void loadBilling()
                      setReferralRefresh((value) => value + 1)
                    }
                    void loadAccountProfile()
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {status === 'loading' ? (
                    <Icon name="loading" size="xs" className="animate-spin" />
                  ) : null}
                  {tBilling('action.refresh')}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  type="button"
                  onClick={onClose}
                  aria-label={tBilling('account.closeAria')}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Icon name="close" />
                </Button>
              </div>
            </header>
          )}

          {mobileSettings ? null : (
            <div className="shrink-0 border-b border-border md:hidden">
              <div className="flex gap-2 overflow-x-auto px-4 py-3">
                {(
                  [
                    ...(overviewVisible ? ([['overview', 'nav.overview']] as const) : []),
                    ['settings', 'nav.settings'],
                    ...(billingVisible
                      ? ([
                          ['billing', 'nav.billing'],
                          ['referrals', 'nav.referrals'],
                        ] as const)
                      : []),
                  ] as const
                ).map(([value, labelKey]) => (
                  <Button
                    key={value}
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() => setView(value)}
                    aria-pressed={activeView === value}
                    className={`min-w-0 flex-1 px-2 ${
                      activeView === value ? 'bg-accent text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    {tBilling(labelKey)}
                  </Button>
                ))}
              </div>
              {billingVisible ? (
                <div className="flex gap-2 px-4 pb-3">
                  <Button
                    size="default"
                    type="button"
                    onClick={onOpenPricing}
                    className="min-w-0 flex-1"
                  >
                    {tBilling('action.subscribe')}
                  </Button>
                  <Button
                    variant="outline"
                    size="default"
                    type="button"
                    onClick={onOpenRecharge}
                    className="min-w-0 flex-1"
                  >
                    {tBilling('action.recharge')}
                  </Button>
                </div>
              ) : null}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            {activeView === 'settings' ? (
              <AccountSettings username={username} onAccountDeleted={onAccountDeleted} />
            ) : null}
            {activeView !== 'settings' && status === 'loading' && !account ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                {tBilling('account.loading')}
              </div>
            ) : null}
            {activeView !== 'settings' && status === 'error' && !account ? (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
              >
                <span>
                  {tBilling('account.loadFailed', { reason: friendlyBillingError(error) })}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void loadBilling()}
                >
                  {tBilling('action.retry')}
                </Button>
              </div>
            ) : null}

            {overviewVisible && account && activeView === 'overview' ? (
              <div className="space-y-4">
                {billingVisible ? (
                  <>
                    <section className="overflow-hidden rounded-3xl border border-border bg-background text-foreground">
                      <div className="p-6">
                        <div className="text-xs text-muted-foreground">
                          {tBilling('account.availableCredits')}
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <CreditIcon className="h-6 w-6 text-foreground" />
                          <span className="text-display font-semibold tracking-tight tabular-nums">
                            {total === null ? '—' : formatCredits(total)}
                          </span>
                        </div>
                        {availableImages === null ? null : (
                          <div className="mt-2 text-xs text-muted-foreground">
                            {tBilling('account.estimatedImages', {
                              count: availableImages,
                              n: formatCredits(availableImages),
                            })}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-6 py-3 text-sm">
                        <span className="font-medium">{planName}</span>
                        <span className="text-xs text-muted-foreground">
                          {account.subscription
                            ? tBilling('account.validUntil', {
                                date: formatDate(account.subscription.ends_at),
                              })
                            : tBilling('account.noActivePlanHint')}
                        </span>
                      </div>
                      {account.subscription?.scheduled_change ? (
                        <p className="border-t border-border px-6 py-3 text-xs text-muted-foreground">
                          {tBilling('orders.scheduledDetail', {
                            name: account.subscription.scheduled_change.plan_name,
                            date: formatDate(account.subscription.scheduled_change.effective_at),
                          })}
                        </p>
                      ) : null}
                    </section>

                    <section>
                      <div className="mb-3 flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-foreground">
                          {tBilling('account.creditBreakdown')}
                        </h3>
                        <span className="text-xs text-muted-foreground">
                          {tBilling('account.subscriptionFirst')}
                        </span>
                      </div>
                      {credits && total !== null ? (
                        <div className="grid gap-3 sm:grid-cols-2">
                          <CreditCard
                            label={tBilling('bucket.subscription')}
                            value={credits.subscription_balance}
                            footnote={
                              credits.subscription_expires_at === null
                                ? tBilling('account.noSubscriptionCredits')
                                : tBilling('account.validUntil', {
                                    date: formatDate(credits.subscription_expires_at),
                                  })
                            }
                          />
                          <CreditCard
                            label={tBilling('bucket.recharge')}
                            value={credits.recharge_balance}
                            footnote={tBilling('account.rechargeFootnote')}
                          />
                        </div>
                      ) : null}
                    </section>
                  </>
                ) : null}

                <ActivitySection />

                {billingVisible ? (
                  <Button
                    variant="outline"
                    size="default"
                    type="button"
                    onClick={() => setView('billing')}
                    className="h-auto min-h-9 w-full justify-between gap-4 whitespace-normal px-4 py-4 text-left"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-foreground">
                        {tBilling('account.viewLedger')}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {tBilling('account.viewLedgerHint')}
                      </span>
                    </span>
                    <Icon name="chevronRight" className="text-muted-foreground" />
                  </Button>
                ) : null}
              </div>
            ) : null}

            {billingVisible && account && activeView === 'billing' ? (
              <section>
                <div className="mb-4">
                  <h3 className="text-base font-semibold text-foreground">
                    {tBilling('nav.billing')}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {tBilling('account.ledgerHint')}
                  </p>
                </div>

                {visibleBillingEntries.length === 0 ? (
                  <div className="grid min-h-72 place-items-center rounded-3xl border border-dashed border-border bg-muted text-center">
                    <div>
                      <div className="text-base font-medium text-foreground">
                        {tBilling('account.ledgerEmpty')}
                      </div>
                      <div className="mt-2 text-sm text-muted-foreground">
                        {tBilling(
                          nextLedgerOffset !== null
                            ? 'account.ledgerEmptyPaged'
                            : 'account.ledgerEmptyHint',
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-muted">
                    {visibleBillingEntries.map((entry) => (
                      <article
                        key={entry.id}
                        className="flex items-center justify-between gap-4 p-4"
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <div
                            className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl text-sm font-semibold ${
                              entry.amount >= 0
                                ? 'bg-success/10 text-success'
                                : 'bg-muted text-muted-foreground'
                            }`}
                            aria-hidden="true"
                          >
                            <Icon name={entry.amount >= 0 ? 'moveDown' : 'moveUp'} />
                          </div>
                          <div className="min-w-0">
                            <h4 className="truncate text-sm font-semibold text-foreground">
                              {userBillingEntryTitle(entry)}
                            </h4>
                            <p className="mt-1 truncate text-xs text-muted-foreground">
                              {userBillingEntryDescription(entry, account?.model_prices ?? [])} ·{' '}
                              {formatDate(entry.created_at)}
                            </p>
                          </div>
                        </div>
                        <div
                          className={`shrink-0 text-sm font-semibold tabular-nums ${
                            entry.amount >= 0 ? 'text-success' : 'text-foreground'
                          }`}
                        >
                          {entry.amount > 0 ? '+' : ''}
                          {formatCredits(entry.amount)}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
                {ledgerError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {tBilling('error.temporary')}
                  </p>
                ) : null}
                {nextLedgerOffset !== null ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() => void loadOlderBillingEntries()}
                    disabled={ledgerLoading}
                    className="mt-3 w-full"
                  >
                    {tBilling(ledgerLoading ? 'account.loadingMore' : 'account.loadOlder')}
                  </Button>
                ) : null}
              </section>
            ) : null}
            {billingVisible && activeView === 'referrals' ? (
              <ReferralPanel refreshKey={referralRefresh} />
            ) : null}
          </div>
        </main>
      </div>
    </Overlay>
  )
}

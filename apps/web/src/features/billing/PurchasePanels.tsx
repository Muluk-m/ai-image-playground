import type { BillingPeriodMonths } from '@image-playground/shared'
import { useEffect, useState } from 'react'
import { Button, Dialog, Icon, openPricingSheet, SegmentedTabs } from '../../lib/privateHost'
import {
  maxCycleDiscount,
  type PlanPeriodPriceEntry,
  summarizeDiscount,
  yearlyNudgeSavedCents,
} from '../pricing/discount'
import { PERIOD_ORDER, periodLabel, planDisplayName } from './billing-display'
import {
  approximateImages,
  clearPricingLaunchPeriod,
  clearRechargeLaunchAmount,
  formatCredits,
  formatDate,
  formatMoney,
  friendlyBillingError,
  loadBilling,
  peekPricingLaunchPeriod,
  peekRechargeLaunchAmount,
  useBilling,
} from './billing-store'
import { tBilling, useTranslation } from './i18n'
import { rankedPlanIds, tierOf } from './membership-tier'
import { OrderHistory, PaymentPanel } from './PaymentPanel'
import TierBadge, { TIER_COLORS } from './TierBadge'
import { PurchaseFeedback, usePurchaseOrder } from './usePurchaseOrder'

/** 徽标读 plan.id；旧数据可能只有 plan_id。两者不一致时以 plan.id 为准。 */
function subscriptionPlanId(
  subscription:
    | { plan?: { id?: string | null } | null; plan_id?: string | null }
    | null
    | undefined,
): string | null {
  return subscription?.plan?.id || subscription?.plan_id || null
}

export function PricingPanel({ onClose }: { onClose: () => void }) {
  const { i18n } = useTranslation()
  const { t: tShell } = useTranslation('shell')
  const isZhLocale = (i18n.resolvedLanguage ?? i18n.language).startsWith('zh')
  const { status, account, catalog, error } = useBilling()
  const [period, setPeriod] = useState<BillingPeriodMonths>(() => peekPricingLaunchPeriod() ?? 1)
  useEffect(() => {
    clearPricingLaunchPeriod()
  }, [])
  const purchase = usePurchaseOrder()
  const { order, setOrder, busy } = purchase
  const [history, setHistory] = useState(false)
  const [buyingPlan, setBuyingPlan] = useState<string | null>(null)
  const buy = async (planId: string) => {
    setBuyingPlan(planId)
    await purchase.buy({ planId, period })
    setBuyingPlan(null)
  }
  if (order) return <PaymentPanel initial={order} onClose={() => setOrder(null)} />
  if (history)
    return (
      <OrderHistory
        onSelect={(value) => {
          setOrder(value)
          setHistory(false)
        }}
        onClose={() => setHistory(false)}
      />
    )

  const allPlanPriceEntries: PlanPeriodPriceEntry[][] = (catalog?.plans ?? []).map((plan) =>
    plan.prices.map((entry) => ({
      periodMonths: entry.period_months,
      originalCents: entry.original_price_cents,
      effectiveCents: entry.effective_price_cents,
    })),
  )
  const rankedIds = catalog ? rankedPlanIds(catalog.plans) : []
  const activePlanId = subscriptionPlanId(account?.subscription)
  // 遵循设计规范「同一视图里实心芽绿按钮只有一个」：未订阅或入门档主推标准版，其余高亮当前套餐。
  const hasStandardPlan = catalog?.plans.some((plan) => tierOf(plan.id, rankedIds) === 'plus')
  const primaryCtaPlanId =
    !activePlanId || (activePlanId === 'starter' && hasStandardPlan)
      ? (catalog?.plans.find((plan) => tierOf(plan.id, rankedIds) === 'plus')?.id ??
        catalog?.plans[0]?.id ??
        null)
      : activePlanId

  return (
    <Dialog
      title={tBilling('pricing.title')}
      onClose={onClose}
      closeDisabled={busy}
      className="max-w-6xl"
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
        <p className="text-body-sm text-muted-foreground">{tBilling('pricing.subtitle')}</p>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              openPricingSheet()
              onClose()
            }}
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
          >
            {tShell('nav.plans')}
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={() => setHistory(true)}
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
          >
            {tBilling('orders.history')} <Icon name="history" />
          </Button>
        </div>
      </div>
      <PurchaseFeedback purchase={purchase} />
      <div className="flex justify-center">
        <div className="inline-flex rounded-full border border-border bg-muted p-1">
          <SegmentedTabs
            label={tBilling('pricing.title')}
            tabs={PERIOD_ORDER.map((value) => {
              const highlight = value > 1 ? maxCycleDiscount(allPlanPriceEntries, value) : null
              const isYearly = value === 12
              return {
                value: String(value),
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <span>{periodLabel(value)}</span>
                    {highlight ? (
                      <span
                        className={
                          isYearly
                            ? 'rounded-full bg-primary px-1.5 py-0.5 text-label-sm font-semibold text-primary-foreground'
                            : 'rounded-full bg-primary/15 px-1.5 py-0.5 text-label-sm font-semibold text-primary'
                        }
                      >
                        {tBilling('pricing.tabSave', { percent: highlight.savePercent })}
                      </span>
                    ) : null}
                  </span>
                ),
              }
            })}
            value={String(period)}
            onChange={(value) => {
              const nextPeriod = PERIOD_ORDER.find((entry) => String(entry) === value)
              if (!busy && nextPeriod !== undefined) {
                setPeriod(nextPeriod)
                purchase.resetFeedback()
              }
            }}
          />
        </div>
      </div>

      {status === 'loading' && !catalog ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          {tBilling('pricing.loading')}
        </div>
      ) : null}
      {status === 'error' && !catalog ? (
        <div
          role="alert"
          className="mx-auto mt-8 flex max-w-xl flex-wrap items-center justify-between gap-3 rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
        >
          <span>{tBilling('pricing.loadFailed', { reason: friendlyBillingError(error) })}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void loadBilling()}>
            {tBilling('action.retry')}
          </Button>
        </div>
      ) : null}

      {catalog ? (
        <div className="mt-6 grid items-stretch gap-4 lg:grid-cols-3">
          {catalog.plans.map((plan) => {
            // 档位色与徽标跟账户面板同一套：定价页选的就是右上角之后会显示的那个等级。
            const tier = tierOf(plan.id, rankedIds)
            const accent = TIER_COLORS[tier]
            const isPopular = tier === 'plus'
            const isBestValue = tier === 'max'
            const isElevated = isPopular || isBestValue
            const price = plan.prices.find((entry) => entry.period_months === period)
            const monthlyEntry = plan.prices.find((entry) => entry.period_months === 1)
            const planEntries: PlanPeriodPriceEntry[] = plan.prices.map((entry) => ({
              periodMonths: entry.period_months,
              originalCents: entry.original_price_cents,
              effectiveCents: entry.effective_price_cents,
            }))
            const discount = price
              ? summarizeDiscount({
                  periodMonths: period,
                  originalCents: price.original_price_cents,
                  effectiveCents: price.effective_price_cents,
                  monthlyOriginalCents: monthlyEntry?.original_price_cents ?? null,
                })
              : null
            const yearlySaved = yearlyNudgeSavedCents(planEntries, period)
            const currentPlan = activePlanId === plan.id
            const scheduled = account?.subscription?.scheduled_change ?? null
            const scheduledHere = scheduled?.plan_id === plan.id
            // 与 BFF 下单判定一致：月度积分更高的档位核款后立即生效，其余换档到期后生效。
            const upgrade =
              !currentPlan &&
              plan.monthly_credits >
                (catalog.plans.find((entry) => entry.id === activePlanId)?.monthly_credits ??
                  Number.POSITIVE_INFINITY)
            const paymentsOn = catalog.settings?.payments_enabled === true
            const scheduledBlocks = Boolean(scheduled) && !currentPlan
            const purchasable = Boolean(price) && paymentsOn && !scheduledBlocks
            const imageCount = approximateImages(plan.monthly_credits, catalog.model_prices)
            const monthlyPrice =
              price === undefined ? null : price.effective_price_cents / price.period_months
            const showMonthlyUnit = monthlyPrice !== null && monthlyPrice % 100 === 0
            const showCompareMonthly =
              showMonthlyUnit && discount !== null && discount.monthlyCompareCents % 100 === 0
            const isPrimaryCta = plan.id === primaryCtaPlanId
            const discountBadgeText =
              discount?.hasSavings && discount.zhFold && discount.savePercent
                ? tBilling(discount.isPromo ? 'pricing.discountFold' : 'pricing.bundleFold', {
                    value: isZhLocale ? discount.zhFold : String(discount.savePercent),
                  })
                : null

            return (
              <article
                key={plan.id}
                className="relative flex flex-col overflow-hidden rounded-2xl border bg-card p-5"
                style={{
                  borderColor: currentPlan
                    ? accent
                    : isPopular
                      ? `color-mix(in srgb, ${accent} 58%, transparent)`
                      : isBestValue
                        ? `color-mix(in srgb, ${accent} 48%, transparent)`
                        : `color-mix(in srgb, ${accent} 24%, transparent)`,
                  backgroundImage:
                    currentPlan || isElevated
                      ? `radial-gradient(110% 55% at 50% 0%, color-mix(in srgb, ${accent} 16%, transparent) 0%, transparent 72%)`
                      : `radial-gradient(100% 45% at 50% 0%, color-mix(in srgb, ${accent} 6%, transparent) 0%, transparent 65%)`,
                }}
              >
                {currentPlan || isElevated ? (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 top-0 h-1"
                    style={{
                      background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
                    }}
                  />
                ) : null}

                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="flex items-center gap-2 text-xl font-semibold text-foreground">
                      <TierBadge tier={tier} size={20} />
                      {planDisplayName(plan.id, plan.name)}
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {tBilling('pricing.monthlyGrant', {
                        count: plan.monthly_credits,
                        n: formatCredits(plan.monthly_credits),
                      })}
                    </p>
                  </div>
                  {currentPlan ? (
                    <span
                      className="inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-label-sm font-semibold"
                      style={{
                        color: accent,
                        background: `color-mix(in srgb, ${accent} 16%, transparent)`,
                      }}
                    >
                      {tBilling('pricing.currentPlan')}
                    </span>
                  ) : scheduledHere ? (
                    <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-label-sm font-semibold text-foreground">
                      {tBilling('orders.scheduled')}
                    </span>
                  ) : isPopular ? (
                    <span
                      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-label-sm font-semibold"
                      style={{
                        color: accent,
                        background: `color-mix(in srgb, ${accent} 16%, transparent)`,
                      }}
                    >
                      <Icon name="flame" size="xs" filled />
                      {tBilling('pricing.popular')}
                    </span>
                  ) : isBestValue ? (
                    <span
                      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-label-sm font-semibold"
                      style={{
                        color: accent,
                        background: `color-mix(in srgb, ${accent} 16%, transparent)`,
                      }}
                    >
                      <Icon name="membershipMax" size="xs" filled />
                      {tBilling('pricing.bestValue')}
                    </span>
                  ) : null}
                </div>

                <div className="mt-5">
                  <div className="mb-2 flex min-h-6 flex-wrap items-center gap-2 text-xs">
                    {discountBadgeText && discount ? (
                      <>
                        <span
                          className="rounded-sm px-2 py-0.5 font-semibold"
                          style={{
                            color: accent,
                            background: `color-mix(in srgb, ${accent} 18%, transparent)`,
                          }}
                        >
                          {discountBadgeText}
                        </span>
                        <del className="tabular-nums text-muted-foreground">
                          {formatMoney(
                            showCompareMonthly
                              ? discount.monthlyCompareCents
                              : discount.compareOriginalCents,
                          )}
                          {showCompareMonthly
                            ? tBilling('pricing.perMonth')
                            : ` / ${periodLabel(period)}`}
                        </del>
                      </>
                    ) : null}
                  </div>
                  {price && monthlyPrice !== null ? (
                    <div className="flex items-baseline gap-1 text-foreground">
                      <span className="text-xl font-medium text-muted-foreground">¥</span>
                      <span className="text-display font-semibold leading-none tracking-tight tabular-nums">
                        {showMonthlyUnit ? monthlyPrice / 100 : price.effective_price_cents / 100}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {showMonthlyUnit
                          ? tBilling('pricing.perMonth')
                          : ` / ${periodLabel(period)}`}
                      </span>
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      {tBilling('pricing.noPrice')}
                    </div>
                  )}
                  <div className="mt-2 flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    {price && period > 1 ? (
                      <span className="tabular-nums text-muted-foreground">
                        {tBilling('pricing.periodTotal', {
                          months: period,
                          amount: formatMoney(price.effective_price_cents),
                        })}
                      </span>
                    ) : null}
                    {discount?.hasSavings ? (
                      <span className="font-semibold tabular-nums" style={{ color: accent }}>
                        {tBilling('pricing.saveAmount', {
                          amount: formatMoney(discount.savedCents),
                        })}
                      </span>
                    ) : null}
                  </div>
                </div>

                <Button
                  type="button"
                  disabled={!purchasable || busy}
                  // 有价但没开放付款或已有待生效换档时，悬停在置灰按钮上说明原因。
                  title={
                    price && !paymentsOn
                      ? tBilling('orders.unavailable')
                      : scheduledBlocks
                        ? tBilling('orders.changeBlocked')
                        : undefined
                  }
                  aria-busy={busy && buyingPlan === plan.id}
                  onClick={() => {
                    if (purchasable) void buy(plan.id)
                  }}
                  variant={isPrimaryCta ? 'default' : 'secondary'}
                  size="lg"
                  className="mt-5 w-full font-semibold"
                >
                  {busy && buyingPlan === plan.id ? (
                    <Icon name="loading" className="animate-spin" />
                  ) : null}
                  {tBilling(
                    busy && buyingPlan === plan.id
                      ? 'recharge.creating'
                      : scheduledHere
                        ? 'orders.scheduled'
                        : currentPlan
                          ? 'orders.renewal'
                          : upgrade
                            ? 'membership.upgrade'
                            : activePlanId
                              ? 'orders.changePlan'
                              : 'membership.subscribe',
                  )}
                </Button>
                {yearlySaved !== null ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    onClick={() => {
                      setPeriod(12)
                      purchase.resetFeedback()
                    }}
                    className="mt-2 w-full text-xs font-medium"
                    style={{ color: accent }}
                  >
                    <span>
                      {tBilling('pricing.switchToYearly', { amount: formatMoney(yearlySaved) })}
                    </span>
                    <Icon name="chevronRight" size="xs" />
                  </Button>
                ) : null}
                {currentPlan && scheduled ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {tBilling('orders.scheduledFrom', {
                      name: planDisplayName(scheduled.plan_id, scheduled.plan_name),
                    })}
                  </p>
                ) : null}
                {!currentPlan && activePlanId ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {scheduledHere
                      ? tBilling('orders.scheduledOn', {
                          date: formatDate(scheduled?.effective_at ?? 0),
                        })
                      : scheduledBlocks
                        ? tBilling('orders.changeBlocked')
                        : tBilling(upgrade ? 'orders.upgradeEffective' : 'orders.changeEffective')}
                  </p>
                ) : null}

                <div className="mt-4 flex-1 border-t border-border pt-4">
                  <div className="text-xs font-medium text-muted-foreground">
                    {tBilling('pricing.includes')}
                  </div>
                  <ul className="mt-3 space-y-2.5 text-sm text-foreground">
                    <li className="flex gap-2">
                      <span className="mt-0.5 inline-flex shrink-0" style={{ color: accent }}>
                        <Icon name="check" />
                      </span>
                      <span className="font-medium">
                        {tBilling('pricing.monthlyCredits', {
                          count: plan.monthly_credits,
                          n: formatCredits(plan.monthly_credits),
                        })}
                      </span>
                    </li>
                    {imageCount === null ? null : (
                      <li className="flex gap-2">
                        <span className="mt-0.5 inline-flex shrink-0" style={{ color: accent }}>
                          <Icon name="check" />
                        </span>
                        <span>
                          {tBilling('pricing.planImages', {
                            count: imageCount,
                            n: formatCredits(imageCount),
                          })}
                        </span>
                      </li>
                    )}
                    <li className="flex gap-2">
                      <span className="mt-0.5 inline-flex shrink-0" style={{ color: accent }}>
                        <Icon name="check" />
                      </span>
                      <span>{tBilling('pricing.creditPriority')}</span>
                    </li>
                    {plan.max_concurrent_tasks === undefined ? null : (
                      <li className="flex gap-2">
                        <span className="mt-0.5 inline-flex shrink-0" style={{ color: accent }}>
                          <Icon name="check" />
                        </span>
                        <span>
                          {tBilling('pricing.concurrentTasks', {
                            count: plan.max_concurrent_tasks,
                            n: plan.max_concurrent_tasks,
                          })}
                        </span>
                      </li>
                    )}
                  </ul>
                </div>
              </article>
            )
          })}
        </div>
      ) : null}
    </Dialog>
  )
}

export function RechargePanel({ onClose }: { onClose: () => void }) {
  useTranslation()
  const { catalog, status, error } = useBilling()
  const [amount, setAmount] = useState(() => peekRechargeLaunchAmount() ?? 50)
  useEffect(() => {
    clearRechargeLaunchAmount()
  }, [])
  const purchase = usePurchaseOrder()
  const { order, setOrder, busy } = purchase
  const [history, setHistory] = useState(false)
  const pricing = catalog?.recharge_pricing
  const yuan =
    pricing && pricing.amounts_yuan.includes(amount) ? amount : (pricing?.amounts_yuan[0] ?? amount)
  const valid = !!pricing?.amounts_yuan.includes(yuan)
  const available = !!catalog?.settings?.payments_enabled && !!pricing
  const buy = async () => {
    if (!valid || !available || busy) return
    await purchase.buy({ amountCents: yuan * 100 })
  }
  if (order) return <PaymentPanel initial={order} onClose={() => setOrder(null)} />
  if (history)
    return (
      <OrderHistory
        onSelect={(value) => {
          setOrder(value)
          setHistory(false)
        }}
        onClose={() => setHistory(false)}
      />
    )
  return (
    <Dialog title={tBilling('action.recharge')} onClose={onClose} closeDisabled={busy}>
      <p className="mt-2 text-sm text-muted-foreground">{tBilling('recharge.subtitle')}</p>
      {status === 'error' && !pricing ? (
        <div
          role="alert"
          className="my-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <span>{tBilling('recharge.loadFailed', { reason: friendlyBillingError(error) })}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void loadBilling()}>
            {tBilling('action.retry')}
          </Button>
        </div>
      ) : (
        <>
          {pricing ? (
            <p className="mt-4 font-medium">
              {tBilling('recharge.rate', { n: formatCredits(pricing.credits_per_yuan) })}
            </p>
          ) : (
            <p className="mt-4 text-muted-foreground">
              {tBilling(status === 'loading' ? 'recharge.loading' : 'recharge.unavailable')}
            </p>
          )}
          <div className="my-4 grid grid-cols-3 gap-2">
            {(pricing?.amounts_yuan ?? [10, 50, 100]).map((value) => (
              <Button
                type="button"
                key={value}
                disabled={busy || !pricing}
                aria-pressed={yuan === value}
                onClick={() => {
                  setAmount(value)
                  purchase.resetFeedback()
                }}
                variant={yuan === value ? 'secondary' : 'outline'}
              >
                ¥{value}
              </Button>
            ))}
          </div>
          {pricing ? (
            <p className="my-4 text-base font-semibold" aria-live="polite">
              {tBilling('recharge.credits', {
                n: formatCredits(valid ? yuan * pricing.credits_per_yuan : 0),
              })}
            </p>
          ) : null}
          <PurchaseFeedback purchase={purchase} />
          {!available && pricing ? (
            <p className="mb-3 text-sm text-muted-foreground">{tBilling('recharge.unavailable')}</p>
          ) : null}
          {!purchase.conflict ? (
            <Button
              type="button"
              disabled={!valid || !available || busy}
              aria-busy={busy}
              onClick={() => void buy()}
              className="w-full"
            >
              {busy ? <Icon name="loading" className="animate-spin" /> : null}
              {tBilling(busy ? 'recharge.creating' : 'recharge.pay')}
            </Button>
          ) : null}
        </>
      )}
      <Button
        type="button"
        disabled={busy}
        onClick={() => setHistory(true)}
        variant="ghost"
        className="mt-4 w-full text-muted-foreground"
      >
        {tBilling('orders.history')}
      </Button>
    </Dialog>
  )
}

import type { BillingPeriodMonths } from '@image-playground/shared'
import { useState } from 'react'
import { Button, Dialog, Icon, openPricingSheet, SegmentedTabs } from '../../lib/privateHost'
import { isDiscounted, PERIOD_ORDER, periodLabel, planDisplayName } from './billing-display'
import {
  approximateImages,
  formatCredits,
  formatDate,
  formatMoney,
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
  useTranslation()
  const { t: tShell } = useTranslation('shell')
  const { status, account, catalog, error } = useBilling()
  const [period, setPeriod] = useState<BillingPeriodMonths>(1)
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

  return (
    <Dialog title={tBilling('pricing.title')} onClose={onClose} className="max-w-6xl">
      <div className="mb-6 rounded-2xl border border-border bg-muted p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold tracking-widest text-muted-foreground">
            {tBilling('pricing.eyebrow')}
          </span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
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
              onClick={() => setHistory(true)}
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
            >
              {tBilling('orders.history')} <Icon name="history" />
            </Button>
          </div>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{tBilling('pricing.subtitle')}</p>
      </div>
      <PurchaseFeedback purchase={purchase} />
      <div className="flex justify-center">
        <SegmentedTabs
          label={tBilling('pricing.title')}
          tabs={PERIOD_ORDER.map((value) => ({ value: String(value), label: periodLabel(value) }))}
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

      {status === 'loading' && !catalog ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          {tBilling('pricing.loading')}
        </div>
      ) : null}
      {status === 'error' && !catalog ? (
        <div className="mx-auto mt-8 max-w-xl rounded-2xl border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          {tBilling('pricing.loadFailed', { reason: error })}
        </div>
      ) : null}

      {catalog ? (
        <div className="mt-8 grid gap-4 lg:grid-cols-3">
          {catalog.plans.map((plan) => {
            // 档位色与徽标跟账户面板同一套：定价页选的就是右上角之后会显示的那个等级。
            const tier = tierOf(plan.id, rankedPlanIds(catalog.plans))
            const accent = TIER_COLORS[tier]
            const price = plan.prices.find((entry) => entry.period_months === period)
            const currentPlanId = subscriptionPlanId(account?.subscription)
            const currentPlan = currentPlanId === plan.id
            const scheduled = account?.subscription?.scheduled_change ?? null
            const scheduledHere = scheduled?.plan_id === plan.id
            // 与 BFF 下单判定一致：月度积分更高的档位核款后立即生效，其余换档到期后生效。
            const upgrade =
              !currentPlan &&
              plan.monthly_credits >
                (catalog.plans.find((entry) => entry.id === currentPlanId)?.monthly_credits ??
                  Number.POSITIVE_INFINITY)
            const paymentsOn = catalog.settings?.payments_enabled === true
            const scheduledBlocks = Boolean(scheduled) && !currentPlan
            const purchasable = Boolean(price) && paymentsOn && !scheduledBlocks
            const imageCount = approximateImages(plan.monthly_credits, catalog.model_prices)
            const monthlyPrice =
              price === undefined ? null : price.effective_price_cents / price.period_months
            return (
              <article
                key={plan.id}
                className="flex flex-col rounded-2xl border p-4"
                style={{
                  borderColor: currentPlan
                    ? accent
                    : `color-mix(in srgb, ${accent} 27%, transparent)`,
                }}
              >
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
                      className="rounded-full px-2.5 py-1 text-label-sm font-semibold"
                      style={{
                        color: accent,
                        background: `color-mix(in srgb, ${accent} 12%, transparent)`,
                      }}
                    >
                      {tBilling('pricing.currentPlan')}
                    </span>
                  ) : scheduledHere ? (
                    <span className="rounded-full bg-muted px-2.5 py-1 text-label-sm font-semibold text-foreground">
                      {tBilling('orders.scheduled')}
                    </span>
                  ) : null}
                </div>

                <div className="mt-6 min-h-20">
                  {price && isDiscounted(price) ? (
                    <div className="mb-2 flex items-center gap-2 text-xs">
                      <span className="rounded-sm bg-muted px-2 py-0.5 font-medium text-foreground">
                        {tBilling('pricing.discount')}
                      </span>
                      <del className="text-muted-foreground">
                        {formatMoney(
                          monthlyPrice !== null &&
                            monthlyPrice % 100 === 0 &&
                            price.original_price_cents % (period * 100) === 0
                            ? price.original_price_cents / period
                            : price.original_price_cents,
                        )}
                        {monthlyPrice !== null &&
                        monthlyPrice % 100 === 0 &&
                        price.original_price_cents % (period * 100) === 0
                          ? tBilling('pricing.perMonth')
                          : ` / ${periodLabel(period)}`}
                      </del>
                    </div>
                  ) : null}
                  {price && monthlyPrice !== null ? (
                    <div className="flex items-end gap-1 text-foreground">
                      <span className="pb-1 text-sm">¥</span>
                      <span className="text-headline font-semibold tracking-tight">
                        {monthlyPrice % 100 === 0
                          ? monthlyPrice / 100
                          : price.effective_price_cents / 100}
                      </span>
                      <span className="pb-1 text-sm text-muted-foreground">
                        {monthlyPrice % 100 === 0
                          ? tBilling('pricing.perMonth')
                          : ` / ${periodLabel(period)}`}
                      </span>
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      {tBilling('pricing.noPrice')}
                    </div>
                  )}
                  {price && period > 1 ? (
                    <div className="mt-1 text-xs text-muted-foreground">
                      {tBilling('pricing.periodTotal', {
                        months: period,
                        amount: formatMoney(price.effective_price_cents),
                      })}
                    </div>
                  ) : null}
                </div>

                <Button
                  type="button"
                  disabled={!purchasable || busy}
                  // 有价但没开放付款时，悬停在置灰的按钮上说明原因（与生成按钮的禁用说明同一套）。
                  title={price && !paymentsOn ? tBilling('orders.unavailable') : undefined}
                  aria-busy={busy && buyingPlan === plan.id}
                  onClick={() => {
                    if (purchasable) void buy(plan.id)
                  }}
                  variant={currentPlan ? 'default' : 'outline'}
                  className="mt-4 w-full"
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
                            : currentPlanId
                              ? 'orders.changePlan'
                              : 'membership.subscribe',
                  )}
                </Button>
                {currentPlan && scheduled ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {tBilling('orders.scheduledFrom', {
                      name: planDisplayName(scheduled.plan_id, scheduled.plan_name),
                    })}
                  </p>
                ) : null}
                {!currentPlan && currentPlanId ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {scheduledHere
                      ? tBilling('orders.scheduledOn', {
                          date: formatDate(scheduled?.effective_at ?? 0),
                        })
                      : tBilling(upgrade ? 'orders.upgradeEffective' : 'orders.changeEffective')}
                  </p>
                ) : null}

                <div className="mt-4 border-t border-border pt-4">
                  <div className="text-xs font-medium text-muted-foreground">
                    {tBilling('pricing.includes')}
                  </div>
                  <ul className="mt-3 space-y-3 text-sm text-foreground">
                    <li className="flex gap-2">
                      <Icon name="check" className="mt-0.5 shrink-0" />
                      <span>
                        {tBilling('pricing.monthlyCredits', {
                          count: plan.monthly_credits,
                          n: formatCredits(plan.monthly_credits),
                        })}
                      </span>
                    </li>
                    {imageCount === null ? null : (
                      <li className="flex gap-2">
                        <Icon name="check" className="mt-0.5 shrink-0" />
                        <span>
                          {tBilling('pricing.planImages', {
                            count: imageCount,
                            n: formatCredits(imageCount),
                          })}
                        </span>
                      </li>
                    )}
                    <li className="flex gap-2">
                      <Icon name="check" className="mt-0.5 shrink-0" />
                      <span>{tBilling('pricing.creditPriority')}</span>
                    </li>
                    {plan.max_concurrent_tasks === undefined ? null : (
                      <li className="flex gap-2">
                        <Icon name="check" className="mt-0.5 shrink-0" />
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
  const { catalog, status } = useBilling()
  const [amount, setAmount] = useState(50)
  const purchase = usePurchaseOrder()
  const { order, setOrder, busy } = purchase
  const [history, setHistory] = useState(false)
  const pricing = catalog?.recharge_pricing
  const yuan = amount
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
    <Dialog title={tBilling('action.recharge')} onClose={onClose}>
      <p className="mt-2 text-sm text-muted-foreground">{tBilling('recharge.subtitle')}</p>
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
            disabled={busy}
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
      <p className="my-4 text-base font-semibold" aria-live="polite">
        {tBilling('recharge.credits', {
          n: formatCredits(valid && pricing ? yuan * pricing.credits_per_yuan : 0),
        })}
      </p>
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
      <Button
        type="button"
        onClick={() => setHistory(true)}
        variant="ghost"
        className="mt-4 w-full text-muted-foreground"
      >
        {tBilling('orders.history')}
      </Button>
    </Dialog>
  )
}

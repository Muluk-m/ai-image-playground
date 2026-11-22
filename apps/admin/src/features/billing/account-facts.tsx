import type { AccountSnapshot, Plan } from '@image-playground/shared'
import { rankedPlanIds, tierOf } from '@image-playground/shared'
import { credits, dateOnly } from './shared'
import TierBadge, { TIER_COLORS } from './TierBadge'

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b py-2.5 last:border-b-0">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span
        className="min-w-0 truncate text-right font-mono text-sm font-medium tabular-nums"
        title={value}
      >
        {value}
      </span>
    </div>
  )
}

function MembershipFact({ data, plans }: { data: AccountSnapshot; plans: readonly Plan[] }) {
  const tier = tierOf(
    data.subscription?.plan.id ?? null,
    rankedPlanIds(plans.filter((plan) => plan.active)),
  )
  const label = data.subscription?.plan.name ?? '无生效套餐'
  return (
    <div className="flex items-center justify-between gap-3 border-b py-2.5">
      <span className="shrink-0 text-xs text-muted-foreground">当前套餐</span>
      <span
        className="flex min-w-0 items-center justify-end gap-1.5 truncate text-right text-sm font-semibold"
        style={{ color: TIER_COLORS[tier] }}
        title={label}
      >
        <TierBadge tier={tier} size={16} aria-hidden />
        <span className="truncate">{label}</span>
      </span>
    </div>
  )
}

function AccountFacts({ data, plans }: { data: AccountSnapshot; plans: readonly Plan[] }) {
  if (!data.account) {
    return (
      <div>
        <Fact label="账务账户" value="未开通（未计费）" />
        <MembershipFact data={data} plans={plans} />
        <Fact label="套餐截止" value={dateOnly(data.subscription?.ends_at ?? null)} />
      </div>
    )
  }
  const subscriptionCredits = data.account.subscription_balance
  const rechargeCredits = data.account.recharge_balance
  const total = subscriptionCredits + rechargeCredits
  const subscriptionShare = total > 0 ? (subscriptionCredits / total) * 100 : 0
  const endsAt = data.subscription?.ends_at
  const expiresSoon = endsAt != null && endsAt > Date.now() && endsAt <= Date.now() + 7 * 86_400_000

  return (
    <div>
      <p className="mb-2 font-mono text-2xl font-semibold tabular-nums">
        {credits(total)} <span className="text-xs font-normal text-muted-foreground">积分</span>
      </p>
      {total > 0 ? (
        <div aria-hidden className="flex h-1.5 overflow-hidden rounded-full bg-muted">
          <span className="bg-brand-hover" style={{ width: `${subscriptionShare}%` }} />
          <span className="flex-1 bg-brand-mint" />
        </div>
      ) : null}
      <Fact label="套餐积分" value={credits(data.account.subscription_balance)} />
      <Fact label="到期" value={dateOnly(data.account.subscription_expires_at)} />
      <Fact label="充值积分" value={credits(data.account.recharge_balance)} />
      <MembershipFact data={data} plans={plans} />
      <div className={expiresSoon ? 'text-warning' : undefined}>
        <Fact label="套餐截止" value={dateOnly(endsAt ?? null)} />
      </div>
    </div>
  )
}

export { AccountFacts, Fact }

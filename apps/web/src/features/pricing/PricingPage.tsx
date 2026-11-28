import { type MembershipTier, rankedPlanIds, tierOf } from '@image-playground/shared'
import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext'
import { compactModelName } from '../../components/ModelIdentity'
import { Icon } from '../../components/ui/icon'
import { i18next, setDocumentTitleOverride, useTranslation } from '../../i18n'
import { formatCount, formatNumber } from '../../i18n/format'
import { useLocalePicker } from '../../i18n/useLocalePicker'
import { isClientCapabilityEnabled } from '../../lib/clientCapabilities'
import { navigate } from '../../lib/pathname'
import {
  clearPendingBillingModal,
  hasPendingBillingModal,
  openPricing,
  openRecharge,
  queueBillingModal,
} from '../billing/billing-store'
import TierBadge, { TIER_COLORS } from '../billing/TierBadge'
import { GUIDE_PATHS } from '../guide/paths'
import {
  BILLING_CYCLES,
  type BillingCycle,
  imagesPerMonth,
  loadPublicCatalog,
  monthlyEquivalentCents,
  type PublicCatalog,
  type PublicPlan,
  rechargeCredits,
} from './catalog'
import {
  maxCycleDiscount,
  type PlanPeriodPriceEntry,
  summarizeDiscount,
  yearlyNudgeSavedCents,
} from './discount'
import { closePricingSheet } from './pricingSheetState'

const PLAN_NAME = {
  starter: 'plan.starterName',
  standard: 'plan.standardName',
  professional: 'plan.professionalName',
} as const

const PLAN_TAGLINE = {
  starter: 'plan.starterTagline',
  standard: 'plan.standardTagline',
  professional: 'plan.professionalTagline',
} as const

const FAQ_ITEMS = [
  { q: 'faq.grantQ', a: 'faq.grantA' },
  { q: 'faq.rolloverQ', a: 'faq.rolloverA' },
  { q: 'faq.orderQ', a: 'faq.orderA' },
  { q: 'faq.failureQ', a: 'faq.failureA' },
  { q: 'faq.unitQ', a: 'faq.unitA' },
  { q: 'faq.estimateQ', a: 'faq.estimateA' },
  { q: 'faq.rechargeQ', a: 'faq.rechargeA' },
  { q: 'faq.renewQ', a: 'faq.renewA' },
  { q: 'faq.inviteQ', a: 'faq.inviteA' },
] as const

function knownPlan(id: string): 'starter' | 'standard' | 'professional' | null {
  if (id === 'starter' || id === 'standard' || id === 'professional') return id
  return null
}

function formatAmounts(amounts: readonly number[], locale: string): string {
  if (locale === 'zh-CN') return amounts.join('、')
  if (amounts.length <= 1) return String(amounts[0] ?? '')
  return `${amounts.slice(0, -1).join(', ')} and ${amounts[amounts.length - 1]}`
}

function formatRate(value: number): string {
  return Number.isInteger(value)
    ? formatCount(value)
    : formatNumber(value, { maximumFractionDigits: 2 })
}

function rewardPercent(basisPoints: number): string {
  return formatNumber(basisPoints / 100, { maximumFractionDigits: 2 })
}

function yuanText(cents: number): string {
  const yuan = cents / 100
  const digits = Number.isInteger(yuan) ? 0 : 2
  return formatNumber(yuan, { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function money(cents: number): string {
  return `¥${yuanText(cents)}`
}

export default function PricingPage({
  presentation = 'page',
}: {
  /** `sheet` 把同一份定价正文放进工作台弹层，不改地址。 */
  presentation?: 'page' | 'sheet'
}) {
  const embedded = presentation === 'sheet'
  const { t } = useTranslation('pricing')
  const { t: tCommon } = useTranslation('common')
  const { t: tShell } = useTranslation('shell')
  const { locale, change } = useLocalePicker()
  const auth = useAuth()
  const [cycle, setCycle] = useState<BillingCycle>(1)
  const [rechargeYuan, setRechargeYuan] = useState<number>(50)
  const [openFaq, setOpenFaq] = useState<string>('faq.grantQ')
  const [catalog, setCatalog] = useState<PublicCatalog | null>(null)
  const [catalogError, setCatalogError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (embedded) return
    document.documentElement.classList.add('pricing-route')
    return () => document.documentElement.classList.remove('pricing-route')
  }, [embedded])

  useEffect(() => {
    if (embedded) return
    setDocumentTitleOverride(() => i18next.t('documentTitle', { ns: 'pricing' }))
    return () => setDocumentTitleOverride(null)
  }, [embedded])

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    setCatalog(null)
    setCatalogError(false)
    loadPublicCatalog(fetch, controller.signal)
      .then((next) => {
        if (!cancelled) setCatalog(next)
      })
      .catch(() => {
        if (!cancelled) setCatalogError(true)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [reloadKey])

  useEffect(() => {
    if (!catalog || catalog.recharge.amountsYuan.includes(rechargeYuan)) return
    const amounts = catalog.recharge.amountsYuan
    setRechargeYuan(amounts[Math.floor((amounts.length - 1) / 2)] ?? amounts[0] ?? 0)
  }, [catalog, rechargeYuan])

  const billingEnabled = isClientCapabilityEnabled('billing:credits')

  useEffect(() => {
    if (embedded || !auth.user || !hasPendingBillingModal()) return
    if (!billingEnabled) {
      clearPendingBillingModal()
      return
    }
    navigate('/image')
  }, [embedded, auth.user, billingEnabled])

  const enter = (intent: 'pricing' | 'recharge' | 'workspace' = 'workspace') => {
    const intentOptions =
      intent === 'pricing'
        ? { period: cycle }
        : intent === 'recharge'
          ? { amountYuan: rechargeYuan }
          : undefined
    if (embedded) {
      closePricingSheet()
      if (auth.enabled && !auth.user) {
        if (billingEnabled && (intent === 'pricing' || intent === 'recharge'))
          queueBillingModal(intent, intentOptions)
        else clearPendingBillingModal()
        auth.login()
        return
      }
      if (intent === 'workspace') {
        clearPendingBillingModal()
        return
      }
      if (!billingEnabled) return
      if (intent === 'pricing') openPricing({ period: cycle })
      else if (intent === 'recharge') openRecharge({ amountYuan: rechargeYuan })
      return
    }
    if (billingEnabled && (intent === 'pricing' || intent === 'recharge'))
      queueBillingModal(intent, intentOptions)
    else clearPendingBillingModal()
    if (auth.enabled && !auth.user) {
      auth.login()
      return
    }
    navigate('/image')
  }

  const leave = () => {
    if (embedded) {
      closePricingSheet()
      return
    }
    window.location.assign(locale === 'en' ? '/en/' : '/')
  }

  const unit =
    cycle === 1 ? t('plan.perMonth') : cycle === 3 ? t('plan.perQuarter') : t('plan.perYear')
  const rawAnchor = catalog?.imageAnchor ?? null
  // 服务端给的是模型 id；页面上显示产品里看到的模型名。
  const anchor = rawAnchor
    ? { ...rawAnchor, model: compactModelName(rawAnchor.model, rawAnchor.model) }
    : null
  const amounts = catalog ? formatAmounts(catalog.recharge.amountsYuan, locale) : ''
  const answerFaq = (id: (typeof FAQ_ITEMS)[number]['a']): string => {
    if (!catalog) return ''
    if (id === 'faq.unitA') {
      return anchor
        ? t('faq.unitA', { model: anchor.model, credits: formatCount(anchor.creditsPerImage) })
        : t('faq.unitAGeneric')
    }
    if (id === 'faq.estimateA') {
      return anchor
        ? t('faq.estimateA', {
            model: anchor.model,
            credits: formatCount(anchor.creditsPerImage),
          })
        : t('faq.estimateAGeneric')
    }
    if (id === 'faq.rechargeA') {
      return t('faq.rechargeA', {
        amounts,
        rate: formatCount(catalog.recharge.creditsPerYuan),
      })
    }
    return t(id)
  }

  const rankedIds = catalog
    ? rankedPlanIds(
        catalog.plans.map((plan) => ({ id: plan.id, monthly_credits: plan.monthlyCredits })),
      )
    : []
  const allPlanPriceEntries: PlanPeriodPriceEntry[][] = (catalog?.plans ?? []).map((plan) =>
    BILLING_CYCLES.flatMap((value) => {
      const entry = plan.prices[value]
      return entry
        ? [
            {
              periodMonths: value,
              originalCents: entry.originalCents,
              effectiveCents: entry.effectiveCents,
            },
          ]
        : []
    }),
  )

  return (
    <div
      data-selectable-text
      className={
        embedded
          ? 'h-full overflow-y-auto font-sans text-[var(--pricing-fg)]'
          : 'min-h-svh bg-[var(--pricing-bg)] font-sans text-[var(--pricing-fg)]'
      }
    >
      <header className="sticky top-0 z-20 border-b border-white/10 bg-[var(--pricing-bg)]/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-5 sm:px-8">
          <a
            href="/"
            onClick={(event) => {
              event.preventDefault()
              leave()
            }}
            className="flex items-center gap-2.5 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--pricing-lime)]"
          >
            <img src="/brand/muvloom-mark.svg" alt="" width={28} height={28} />
            <span className="pricing-copy font-semibold tracking-tight">{t('nav.brand')}</span>
          </a>
          <nav
            className="flex items-center gap-5 text-sm text-white/70"
            aria-label={t('nav.pricing')}
          >
            <a
              href="/pricing"
              aria-current="page"
              className="text-white"
              onClick={
                embedded
                  ? (event) => {
                      event.preventDefault()
                    }
                  : undefined
              }
            >
              {t('nav.pricing')}
            </a>
            <a
              href={GUIDE_PATHS[locale]}
              className="hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--pricing-lime)]"
            >
              {t('nav.guide')}
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <div
              role="group"
              aria-label={t('nav.locale')}
              className="hidden items-center gap-2 text-xs sm:flex"
            >
              {(['zh-CN', 'en'] as const).map((code) => (
                <button // design-allow native-control: 定价页的切换和折叠不是工作台表单控件
                  key={code}
                  type="button"
                  aria-pressed={locale === code}
                  onClick={() => change(code)}
                  className={`rounded-full px-2 py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pricing-lime)] ${
                    locale === code ? 'text-white' : 'text-white/40 hover:text-white'
                  }`}
                >
                  {tCommon(code === 'zh-CN' ? 'locale.zh-CN' : 'locale.en')}
                </button>
              ))}
            </div>
            {embedded ? (
              <button // design-allow native-control: 定价页的切换和折叠不是工作台表单控件
                type="button"
                onClick={closePricingSheet}
                aria-label={tCommon('action.close')}
                className="grid h-9 w-9 place-items-center rounded-full text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pricing-lime)]"
              >
                <Icon name="close" />
              </button>
            ) : (
              <button // design-allow native-control: 定价页的切换和折叠不是工作台表单控件
                type="button"
                onClick={() => enter('workspace')}
                className="h-9 rounded-full bg-white px-4 text-sm font-semibold text-[var(--pricing-ink)] hover:bg-[var(--pricing-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pricing-lime)]"
              >
                {auth.enabled && !auth.user ? t('nav.login') : t('nav.workspace')}
              </button>
            )}
          </div>
        </div>
      </header>

      <main>
        <section
          id="plans"
          className="mx-auto max-w-6xl scroll-mt-24 px-5 pb-20 pt-12 sm:px-8 sm:pt-16"
        >
          <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
            <div className="max-w-xl">
              <h1 className="pricing-section font-semibold tracking-tight">{t('hero.title')}</h1>
              <p className="mt-3 text-sm leading-6 text-white/55">{t('hero.subtitle')}</p>
            </div>
            <div
              role="radiogroup"
              aria-label={t('cycle.label')}
              className="inline-flex w-fit shrink-0 rounded-full bg-white/[0.08] p-1"
            >
              {BILLING_CYCLES.map((value, index) => {
                const selected = cycle === value
                const label =
                  value === 1
                    ? t('cycle.month')
                    : value === 3
                      ? t('cycle.quarter')
                      : t('cycle.year')
                const highlight = value > 1 ? maxCycleDiscount(allPlanPriceEntries, value) : null
                const isYearly = value === 12
                return (
                  <button // design-allow native-control: 定价页的切换和折叠不是工作台表单控件
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => setCycle(value)}
                    onKeyDown={(event) => {
                      let nextIndex = -1
                      if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
                        nextIndex = (index + 1) % BILLING_CYCLES.length
                      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
                        nextIndex = (index - 1 + BILLING_CYCLES.length) % BILLING_CYCLES.length
                      else if (event.key === 'Home') nextIndex = 0
                      else if (event.key === 'End') nextIndex = BILLING_CYCLES.length - 1
                      if (nextIndex < 0) return
                      event.preventDefault()
                      const nextCycle = BILLING_CYCLES[nextIndex]
                      if (nextCycle !== undefined) setCycle(nextCycle)
                      const group = event.currentTarget.parentElement
                      group
                        ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
                        [nextIndex]?.focus()
                    }}
                    className={`inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pricing-lime)] ${
                      selected
                        ? 'bg-white font-semibold text-[var(--pricing-ink)]'
                        : 'text-white/70 hover:text-white'
                    }`}
                  >
                    <span>{label}</span>
                    {highlight ? (
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-label-sm font-semibold ${
                          isYearly
                            ? selected
                              ? 'bg-[var(--pricing-ink)] text-[var(--pricing-lime)]'
                              : 'bg-[var(--pricing-lime)] text-[var(--pricing-ink-strong)]'
                            : selected
                              ? 'bg-[var(--pricing-ink)]/15 text-[var(--pricing-ink)]'
                              : 'bg-[var(--pricing-lime)]/15 text-[var(--pricing-lime)]'
                        }`}
                      >
                        {t('cycle.saveBadge', { percent: highlight.savePercent })}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </div>
          {catalogError ? (
            <div role="alert" className="mt-8">
              <p className="text-sm text-white/60">{t('status.error')}</p>
              <button // design-allow native-control: 定价页的切换和折叠不是工作台表单控件
                type="button"
                onClick={() => setReloadKey((value) => value + 1)}
                className="mt-4 h-10 rounded-full bg-white px-5 text-sm font-semibold text-[var(--pricing-ink)] hover:bg-[var(--pricing-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pricing-lime)]"
              >
                {t('status.retry')}
              </button>
            </div>
          ) : !catalog ? (
            <p role="status" className="mt-8 text-sm text-white/50">
              {t('status.loading')}
            </p>
          ) : (
            <div className="mt-8 grid items-stretch gap-4 pt-3 lg:grid-cols-3">
              {catalog.plans.map((plan) => (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  tier={tierOf(plan.id, rankedIds)}
                  cycle={cycle}
                  unit={unit}
                  imageAnchor={anchor}
                  onSelectCycle={setCycle}
                  onUpgrade={() => enter('pricing')}
                />
              ))}
            </div>
          )}
        </section>

        {catalog ? (
          <>
            <section id="benefits" className="scroll-mt-24 pb-20">
              <div className="mx-auto max-w-6xl px-5 sm:px-8">
                <h2 className="pricing-section font-semibold tracking-tight">
                  {t('compare.title')}
                </h2>
                <div className="mt-6 overflow-x-auto rounded-3xl border border-white/10 bg-[var(--pricing-panel)]">
                  <table className="w-full min-w-[760px] border-collapse text-sm">
                    <caption className="sr-only">{t('compare.caption')}</caption>
                    <thead>
                      <tr className="border-b border-white/10">
                        <th className="sticky left-0 bg-[var(--pricing-panel)] px-5 py-6 text-left font-medium text-white/45">
                          {t('compare.feature')}
                        </th>
                        {catalog.plans.map((plan) => {
                          const known = knownPlan(plan.id)
                          const price = plan.prices[cycle]
                          return (
                            <th key={plan.id} className="px-4 py-6 text-center font-normal">
                              <div className="text-base font-semibold">
                                {known ? t(PLAN_NAME[known]) : plan.name}
                              </div>
                              <div className="mt-1 text-white/55">
                                {price ? `${money(price.effectiveCents)}${unit}` : '—'}
                              </div>
                              <button // design-allow native-control: 定价页的切换和折叠不是工作台表单控件
                                type="button"
                                onClick={() => enter('pricing')}
                                className="mt-3 h-8 rounded-full bg-white px-4 text-xs font-semibold text-[var(--pricing-ink)] hover:bg-[var(--pricing-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pricing-lime)]"
                              >
                                {t('compare.upgrade')}
                              </button>
                            </th>
                          )
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      <GroupLabel label={t('compare.groupPlan')} columns={catalog.plans.length} />
                      <PriceRow plans={catalog.plans} label={t('compare.monthPrice')} cycle={1} />
                      <PriceRow plans={catalog.plans} label={t('compare.quarterPrice')} cycle={3} />
                      <PriceRow plans={catalog.plans} label={t('compare.yearPrice')} cycle={12} />
                      <Row plans={catalog.plans} label={t('compare.credits')}>
                        {(plan) => formatCount(plan.monthlyCredits)}
                      </Row>
                      {anchor ? (
                        <Row
                          plans={catalog.plans}
                          label={t('compare.images', { model: anchor.model })}
                        >
                          {(plan) =>
                            t('compare.imagesValue', {
                              n: formatCount(
                                imagesPerMonth(plan.monthlyCredits, anchor.creditsPerImage),
                              ),
                            })
                          }
                        </Row>
                      ) : null}
                      <SameRow
                        plans={catalog.plans}
                        label={t('compare.grant')}
                        value={t('compare.grantValue')}
                      />
                      <SameRow
                        plans={catalog.plans}
                        label={t('compare.expiry')}
                        value={t('compare.expiryValue')}
                      />
                      <Row plans={catalog.plans} label={t('compare.concurrency')}>
                        {(plan) => t('compare.concurrencyValue', { n: plan.concurrency })}
                      </Row>
                      <SameRow
                        plans={catalog.plans}
                        label={t('compare.billing')}
                        value={t('compare.billingValue')}
                      />

                      <GroupLabel label={t('compare.groupCreate')} columns={catalog.plans.length} />
                      <SameRow
                        plans={catalog.plans}
                        label={t('compare.imageVideo')}
                        value={t('compare.imageVideoValue')}
                      />
                      <SameRow
                        plans={catalog.plans}
                        label={t('compare.canvas')}
                        value={t('compare.canvasValue')}
                      />
                      <SameRow
                        plans={catalog.plans}
                        label={t('compare.agent')}
                        value={t('compare.agentValue')}
                      />
                      <SameRow
                        plans={catalog.plans}
                        label={t('compare.library')}
                        value={t('compare.libraryValue')}
                      />

                      <GroupLabel label={t('compare.groupSpend')} columns={catalog.plans.length} />
                      <SameRow
                        plans={catalog.plans}
                        label={t('compare.meter')}
                        value={t('compare.meterValue')}
                      />
                      {anchor ? (
                        <SameRow
                          plans={catalog.plans}
                          label={t('compare.anchor')}
                          value={t('compare.anchorValue', {
                            model: anchor.model,
                            n: formatCount(anchor.creditsPerImage),
                          })}
                        />
                      ) : null}
                      <SameRow
                        plans={catalog.plans}
                        label={t('compare.failure')}
                        value={t('compare.failureValue')}
                      />
                      <SameRow
                        plans={catalog.plans}
                        label={t('compare.order')}
                        value={t('compare.orderValue')}
                      />
                      <SameRow
                        plans={catalog.plans}
                        label={t('compare.estimate')}
                        value={t('compare.estimateValue')}
                      />
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            <section className="mx-auto max-w-6xl px-5 pb-20 sm:px-8">
              <h2 className="pricing-section font-semibold tracking-tight">{t('rules.title')}</h2>
              <div className="mt-8 grid gap-10 md:grid-cols-2">
                <Rule
                  title={t('rules.meterTitle')}
                  body={
                    anchor
                      ? t('rules.meterBody', {
                          model: anchor.model,
                          credits: formatCount(anchor.creditsPerImage),
                        })
                      : t('rules.meterBodyGeneric')
                  }
                />
                <Rule
                  title={t('rules.bucketTitle')}
                  body={t('rules.bucketBody', {
                    amounts,
                    rate: formatCount(catalog.recharge.creditsPerYuan),
                  })}
                />
                <Rule title={t('rules.cycleTitle')} body={t('rules.cycleBody')} />
                <Rule title={t('rules.failureTitle')} body={t('rules.failureBody')} />
              </div>
              <div className="mt-10 max-w-3xl">
                <Rule
                  title={t('rules.inviteTitle')}
                  body={t(
                    catalog.referral.inviterCredits === catalog.referral.inviteeCredits
                      ? 'rules.inviteBody'
                      : 'rules.inviteBodyUneven',
                    {
                      n: formatCount(catalog.referral.inviteeCredits),
                      inviter: formatCount(catalog.referral.inviterCredits),
                      invitee: formatCount(catalog.referral.inviteeCredits),
                      percent: rewardPercent(catalog.referral.paidRewardBasisPoints),
                      rewardRate: formatRate(catalog.referral.creditsPerYuan),
                    },
                  )}
                />
              </div>
            </section>

            <section id="recharge" className="scroll-mt-24 pb-20">
              <div className="mx-auto max-w-6xl px-5 sm:px-8">
                <h2 className="pricing-section font-semibold tracking-tight">
                  {t('recharge.title')}
                </h2>
                <p className="mt-4 max-w-2xl text-sm leading-7 text-white/60">
                  {t('recharge.subtitle', {
                    rate: formatCount(catalog.recharge.creditsPerYuan),
                  })}
                </p>
                <div
                  className="mt-8 grid gap-4 sm:grid-cols-3"
                  role="radiogroup"
                  aria-label={t('recharge.title')}
                >
                  {catalog.recharge.amountsYuan.map((yuan, index) => {
                    const selected = rechargeYuan === yuan
                    const list = catalog.recharge.amountsYuan
                    return (
                      <button // design-allow native-control: 定价页的切换和折叠不是工作台表单控件
                        key={yuan}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => setRechargeYuan(yuan)}
                        onKeyDown={(event) => {
                          let nextIndex = -1
                          if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
                            nextIndex = (index + 1) % list.length
                          else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
                            nextIndex = (index - 1 + list.length) % list.length
                          else if (event.key === 'Home') nextIndex = 0
                          else if (event.key === 'End') nextIndex = list.length - 1
                          if (nextIndex < 0) return
                          event.preventDefault()
                          const nextAmount = list[nextIndex]
                          if (nextAmount !== undefined) setRechargeYuan(nextAmount)
                          const group = event.currentTarget.parentElement
                          group
                            ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
                            [nextIndex]?.focus()
                        }}
                        className={`rounded-3xl border px-5 py-6 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pricing-lime)] ${
                          selected
                            ? 'border-[var(--pricing-lime)] bg-[var(--pricing-lime)]/10'
                            : 'border-white/10 bg-[var(--pricing-card)] hover:border-white/25'
                        }`}
                      >
                        <div className="text-sm text-white/50">¥{formatCount(yuan)}</div>
                        <div className="mt-3 pricing-pack font-semibold tracking-tight">
                          {t('recharge.credits', {
                            n: formatCount(rechargeCredits(yuan, catalog.recharge.creditsPerYuan)),
                          })}
                        </div>
                        <div className="mt-2 text-sm text-white/45">{t('recharge.valid')}</div>
                      </button>
                    )
                  })}
                </div>
                <button // design-allow native-control: 定价页的切换和折叠不是工作台表单控件
                  type="button"
                  onClick={() => enter('recharge')}
                  className="mt-6 h-11 rounded-full bg-[var(--pricing-lime)] px-6 text-sm font-semibold text-[var(--pricing-ink-strong)] hover:bg-[var(--pricing-lime-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pricing-lime)]"
                >
                  {t('recharge.pay', { amount: formatCount(rechargeYuan) })}
                </button>
              </div>
            </section>

            <section id="faq" className="scroll-mt-24 pb-20">
              <div className="mx-auto max-w-3xl px-5 sm:px-8">
                <h2 className="pricing-section font-semibold tracking-tight">{t('faq.title')}</h2>
                <p className="mt-3 text-sm text-white/50">{t('faq.lead')}</p>
                <div className="mt-6 divide-y divide-white/10 border-y border-white/10">
                  {FAQ_ITEMS.map((item) => {
                    const open = openFaq === item.q
                    const panelId = `pricing-faq-${item.q}`
                    return (
                      <div key={item.q}>
                        <button // design-allow native-control: 定价页的切换和折叠不是工作台表单控件
                          type="button"
                          aria-expanded={open}
                          aria-controls={panelId}
                          onClick={() => setOpenFaq(open ? '' : item.q)}
                          className="flex w-full items-center justify-between gap-6 py-4 text-left pricing-copy font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pricing-lime)]"
                        >
                          {t(item.q)}
                          <Icon
                            name="chevronDown"
                            className={`size-[18px] shrink-0 text-white/50 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
                          />
                        </button>
                        {open ? (
                          <p
                            id={panelId}
                            className="max-w-2xl pb-4 text-sm leading-7 text-white/60"
                          >
                            {answerFaq(item.a)}
                          </p>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              </div>
            </section>
          </>
        ) : null}

        <section className="border-t border-white/10">
          <div className="mx-auto max-w-6xl px-5 py-20 text-center sm:px-8">
            <h2 className="pricing-close font-semibold tracking-tight">{t('close.title')}</h2>
            <p className="mx-auto mt-4 max-w-lg text-sm leading-7 text-white/60">
              {t('close.body')}
            </p>
            <button // design-allow native-control: 定价页的切换和折叠不是工作台表单控件
              type="button"
              onClick={() => enter('workspace')}
              className="mt-8 h-12 rounded-full bg-[var(--pricing-lime)] px-8 text-sm font-semibold text-[var(--pricing-ink-strong)] hover:bg-[var(--pricing-lime-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pricing-lime)]"
            >
              {t('close.action')}
            </button>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-8 text-sm text-white/50 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div className="flex items-center gap-2.5 text-white">
            <img src="/brand/muvloom-mark.svg" alt="" width={22} height={22} />
            <span className="font-medium">{t('footer.brand')}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <a
              href="/image"
              onClick={(event) => {
                event.preventDefault()
                enter('workspace')
              }}
              className="hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--pricing-lime)]"
            >
              {t('footer.start')}
            </a>
            <a
              href={GUIDE_PATHS[locale]}
              className="hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--pricing-lime)]"
            >
              {t('footer.guide')}
            </a>
            <a
              href="/terms"
              target="_blank"
              rel="noopener"
              className="hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--pricing-lime)]"
            >
              {tShell('nav.terms')}
            </a>
            <a
              href="/privacy"
              target="_blank"
              rel="noopener"
              className="hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--pricing-lime)]"
            >
              {tShell('nav.privacy')}
            </a>
            <div role="group" aria-label={t('nav.locale')} className="flex gap-3 sm:hidden">
              {(['zh-CN', 'en'] as const).map((code) => (
                <button // design-allow native-control: 定价页的切换和折叠不是工作台表单控件
                  key={code}
                  type="button"
                  aria-pressed={locale === code}
                  onClick={() => change(code)}
                  className={`focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pricing-lime)] ${
                    locale === code ? 'text-white' : 'hover:text-white'
                  }`}
                >
                  {tCommon(code === 'zh-CN' ? 'locale.zh-CN' : 'locale.en')}
                </button>
              ))}
            </div>
          </div>
          <p>{t('footer.rights', { year: new Date().getFullYear() })}</p>
        </div>
      </footer>
    </div>
  )
}

function PlanCard({
  plan,
  tier,
  cycle,
  unit,
  imageAnchor,
  onSelectCycle,
  onUpgrade,
}: {
  plan: PublicPlan
  tier: MembershipTier
  cycle: BillingCycle
  unit: string
  imageAnchor: PublicCatalog['imageAnchor']
  onSelectCycle: (next: BillingCycle) => void
  onUpgrade: () => void
}) {
  const { t, i18n } = useTranslation('pricing')
  const isZhLocale = (i18n.resolvedLanguage ?? i18n.language).startsWith('zh')
  const price = plan.prices[cycle]
  const monthlyEntry = plan.prices[1]
  const planEntries: PlanPeriodPriceEntry[] = BILLING_CYCLES.flatMap((value) => {
    const entry = plan.prices[value]
    return entry
      ? [
          {
            periodMonths: value,
            originalCents: entry.originalCents,
            effectiveCents: entry.effectiveCents,
          },
        ]
      : []
  })
  const discount = price
    ? summarizeDiscount({
        periodMonths: cycle,
        originalCents: price.originalCents,
        effectiveCents: price.effectiveCents,
        monthlyOriginalCents: monthlyEntry?.originalCents ?? null,
      })
    : null
  const yearlySaved = yearlyNudgeSavedCents(planEntries, cycle)
  const payable = price?.effectiveCents
  const monthly = payable === undefined ? null : monthlyEquivalentCents(payable, cycle)
  const livePrice = payable === undefined ? '—' : money(payable)
  const liveUnit = payable === undefined ? '' : unit
  const known = knownPlan(plan.id)
  const featured = tier === 'plus'
  const bestValue = tier === 'max'
  const elevated = featured || bestValue
  const accent = TIER_COLORS[tier]
  const badgeColor = featured ? 'var(--pricing-lime)' : accent
  const discountBadgeText =
    discount?.hasSavings && discount.zhFold && discount.savePercent
      ? t(discount.isPromo ? 'plan.discountBadge' : 'plan.bundleBadge', {
          value: isZhLocale ? discount.zhFold : String(discount.savePercent),
        })
      : null

  return (
    <article
      className="relative flex h-full flex-col overflow-hidden rounded-3xl border p-6"
      style={{
        backgroundColor: featured ? 'var(--pricing-featured)' : 'var(--pricing-card)',
        borderColor: featured
          ? 'color-mix(in srgb, var(--pricing-lime) 70%, transparent)'
          : bestValue
            ? `color-mix(in srgb, ${accent} 52%, transparent)`
            : 'color-mix(in srgb, var(--pricing-fg) 12%, transparent)',
        backgroundImage: elevated
          ? `radial-gradient(110% 55% at 50% 0%, color-mix(in srgb, ${badgeColor} 16%, transparent) 0%, transparent 70%)`
          : `radial-gradient(100% 45% at 50% 0%, color-mix(in srgb, ${accent} 7%, transparent) 0%, transparent 65%)`,
      }}
    >
      {elevated ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-1"
          style={{
            background: `linear-gradient(90deg, transparent, ${badgeColor}, transparent)`,
          }}
        />
      ) : null}

      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="pricing-name flex items-center gap-2 font-semibold">
            <TierBadge tier={tier} size={20} />
            {known ? t(PLAN_NAME[known]) : plan.name}
          </h2>
          <p className="mt-1 text-sm text-white/50">{known ? t(PLAN_TAGLINE[known]) : null}</p>
        </div>
        {featured ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--pricing-lime)] px-2.5 py-1 pricing-badge font-semibold text-[var(--pricing-ink-strong)]">
            <Icon name="flame" size="xs" filled />
            {t('plan.featured')}
          </span>
        ) : bestValue ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 pricing-badge font-semibold"
            style={{
              color: accent,
              background: `color-mix(in srgb, ${accent} 18%, transparent)`,
            }}
          >
            <Icon name="membershipMax" size="xs" filled />
            {t('plan.bestValue')}
          </span>
        ) : null}
      </div>

      <div className="mt-5 flex min-h-6 flex-wrap items-center gap-2 text-xs">
        {discountBadgeText && discount ? (
          <>
            <span
              className="rounded-sm px-2 py-0.5 font-semibold"
              style={{
                color: badgeColor,
                background: `color-mix(in srgb, ${badgeColor} 18%, transparent)`,
              }}
            >
              {discountBadgeText}
            </span>
            <del className="tabular-nums text-white/40">
              {money(discount.compareOriginalCents)}
              {unit}
            </del>
          </>
        ) : null}
      </div>

      <p className="mt-1.5 flex items-end gap-1" aria-live="polite">
        <span className="pricing-price font-semibold tracking-tight tabular-nums">{livePrice}</span>
        <span className="pb-1.5 text-sm text-white/50">{liveUnit}</span>
      </p>

      <div className="mt-2 flex min-h-5 flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
        {cycle > 1 && monthly !== null ? (
          <span className="tabular-nums text-white/55">
            {t('plan.equivalent', { amount: yuanText(monthly) })}
          </span>
        ) : null}
        {discount?.hasSavings ? (
          <span className="font-semibold tabular-nums" style={{ color: badgeColor }}>
            {t('plan.saveAmount', { amount: money(discount.savedCents) })}
          </span>
        ) : null}
      </div>

      <button // design-allow native-control: 定价页的切换和折叠不是工作台表单控件
        type="button"
        onClick={onUpgrade}
        className={`mt-5 h-11 w-full rounded-full text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pricing-lime)] ${
          featured
            ? 'bg-[var(--pricing-lime)] text-[var(--pricing-ink-strong)] hover:bg-[var(--pricing-lime-hover)]'
            : 'bg-white text-[var(--pricing-ink)] hover:bg-[var(--pricing-hover)]'
        }`}
      >
        {t('plan.upgrade')}
      </button>

      {yearlySaved !== null ? (
        <button // design-allow native-control: 定价页的切换和折叠不是工作台表单控件
          type="button"
          onClick={() => onSelectCycle(12)}
          className="mt-2.5 inline-flex h-7 w-full items-center justify-center gap-1 rounded-full text-xs font-medium hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pricing-lime)]"
          style={{ color: badgeColor }}
        >
          <span>{t('plan.switchToYearly', { amount: money(yearlySaved) })}</span>
          <Icon name="chevronRight" size="xs" />
        </button>
      ) : null}

      <ul className="mt-5 flex-1 space-y-3 border-t border-white/10 pt-5 text-sm">
        <Feature accent={badgeColor}>
          {t('plan.monthlyCredits', { n: formatCount(plan.monthlyCredits) })}
        </Feature>
        {imageAnchor ? (
          <Feature accent={badgeColor}>
            {t('plan.images', {
              model: imageAnchor.model,
              n: formatCount(imagesPerMonth(plan.monthlyCredits, imageAnchor.creditsPerImage)),
            })}
          </Feature>
        ) : null}
        <Feature accent={badgeColor}>{t('plan.concurrency', { n: plan.concurrency })}</Feature>
        <Feature accent={badgeColor}>{t('plan.studio')}</Feature>
      </ul>
      <p className="mt-5 text-sm leading-6 text-white/40">
        {t('plan.grant')}
        <br />
        {t('plan.once')}
      </p>
    </article>
  )
}

function Feature({ children, accent }: { children: string; accent: string }) {
  return (
    <li className="flex gap-2">
      <span className="mt-0.5 inline-flex shrink-0" style={{ color: accent }}>
        <Icon name="check" />
      </span>
      <span>{children}</span>
    </li>
  )
}

function Rule({ title, body }: { title: string; body: string }) {
  return (
    <div className="max-w-xl">
      <h3 className="pricing-name font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-7 text-white/60">{body}</p>
    </div>
  )
}

function GroupLabel({ label, columns }: { label: string; columns: number }) {
  return (
    <tr>
      <th
        colSpan={1 + columns}
        className="bg-white/[0.03] px-5 pb-2 pt-8 text-left text-xs font-medium text-white/40"
      >
        {label}
      </th>
    </tr>
  )
}

function Row({
  plans,
  label,
  children,
}: {
  plans: readonly PublicPlan[]
  label: string
  children: (plan: PublicPlan) => string
}) {
  return (
    <tr className="border-t border-white/[0.08]">
      <th className="sticky left-0 bg-[var(--pricing-panel)] px-5 py-3.5 text-left font-normal text-white/70">
        {label}
      </th>
      {plans.map((plan) => (
        <td key={plan.id} className="px-4 py-3.5 text-center text-white/80">
          {children(plan)}
        </td>
      ))}
    </tr>
  )
}

function SameRow({
  plans,
  label,
  value,
}: {
  plans: readonly PublicPlan[]
  label: string
  value: string
}) {
  return (
    <Row plans={plans} label={label}>
      {() => value}
    </Row>
  )
}

function PriceRow({
  plans,
  label,
  cycle,
}: {
  plans: readonly PublicPlan[]
  label: string
  cycle: BillingCycle
}) {
  return (
    <Row plans={plans} label={label}>
      {(plan) => {
        const price = plan.prices[cycle]
        return price ? money(price.effectiveCents) : '—'
      }}
    </Row>
  )
}

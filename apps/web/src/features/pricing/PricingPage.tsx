import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext'
import { Icon } from '../../components/ui/icon'
import { i18next, setDocumentTitleOverride, useTranslation } from '../../i18n'
import { formatCount, formatNumber } from '../../i18n/format'
import { useLocalePicker } from '../../i18n/useLocalePicker'
import { navigate } from '../../lib/pathname'
import { GUIDE_PATHS } from '../guide/paths'
import {
  BILLING_CYCLES,
  type BillingCycle,
  effectivePriceCents,
  GPT_IMAGE_2_CREDITS,
  imagesPerMonth,
  monthlyEquivalentCents,
  PRICING_PLANS,
  type PricingPlan,
  RECHARGE_AMOUNTS_YUAN,
  RECHARGE_CREDITS_PER_YUAN,
  REFERRAL_REGISTRATION_CREDITS,
  rechargeCredits,
} from './catalog'
import { closePricingSheet } from './pricingSheet'

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
  const { locale, change } = useLocalePicker()
  const auth = useAuth()
  const [cycle, setCycle] = useState<BillingCycle>(1)
  const [rechargeYuan, setRechargeYuan] = useState<number>(50)
  const [openFaq, setOpenFaq] = useState<string>('faq.grantQ')

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

  const enter = () => {
    if (embedded) {
      closePricingSheet()
      if (auth.enabled && !auth.user) auth.login()
      return
    }
    if (auth.enabled && !auth.user) {
      auth.login()
      return
    }
    navigate('/')
  }

  const leave = () => {
    if (embedded) {
      closePricingSheet()
      return
    }
    navigate('/')
  }

  const unit =
    cycle === 1 ? t('plan.perMonth') : cycle === 3 ? t('plan.perQuarter') : t('plan.perYear')

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
                onClick={enter}
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
              {BILLING_CYCLES.map((value) => {
                const selected = cycle === value
                const label =
                  value === 1
                    ? t('cycle.month')
                    : value === 3
                      ? t('cycle.quarter')
                      : t('cycle.year')
                return (
                  <button // design-allow native-control: 定价页的切换和折叠不是工作台表单控件
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setCycle(value)}
                    className={`h-9 rounded-full px-5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pricing-lime)] ${
                      selected
                        ? 'bg-white font-semibold text-[var(--pricing-ink)]'
                        : 'text-white/70 hover:text-white'
                    }`}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="mt-8 grid items-stretch gap-4 pt-3 lg:grid-cols-3">
            {PRICING_PLANS.map((plan) => (
              <PlanCard key={plan.id} plan={plan} cycle={cycle} unit={unit} onUpgrade={enter} />
            ))}
          </div>
        </section>

        <section id="benefits" className="scroll-mt-24 pb-20">
          <div className="mx-auto max-w-6xl px-5 sm:px-8">
            <h2 className="pricing-section font-semibold tracking-tight">{t('compare.title')}</h2>
            <div className="mt-6 overflow-x-auto rounded-3xl border border-white/10 bg-[var(--pricing-panel)]">
              <table className="w-full min-w-[760px] border-collapse text-sm">
                <caption className="sr-only">{t('compare.caption')}</caption>
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="sticky left-0 bg-[var(--pricing-panel)] px-5 py-6 text-left font-medium text-white/45">
                      {t('compare.feature')}
                    </th>
                    {PRICING_PLANS.map((plan) => (
                      <th key={plan.id} className="px-4 py-6 text-center font-normal">
                        <div className="text-base font-semibold">{t(PLAN_NAME[plan.id])}</div>
                        <div className="mt-1 text-white/55">
                          {money(effectivePriceCents(plan.prices[cycle]))}
                          {unit}
                        </div>
                        <button // design-allow native-control: 定价页的切换和折叠不是工作台表单控件
                          type="button"
                          onClick={enter}
                          className="mt-3 h-8 rounded-full bg-white px-4 text-xs font-semibold text-[var(--pricing-ink)] hover:bg-[var(--pricing-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pricing-lime)]"
                        >
                          {t('compare.upgrade')}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <GroupLabel label={t('compare.groupPlan')} />
                  <PriceRow label={t('compare.monthPrice')} cycle={1} />
                  <PriceRow label={t('compare.quarterPrice')} cycle={3} />
                  <PriceRow label={t('compare.yearPrice')} cycle={12} />
                  <Row label={t('compare.credits')}>
                    {(plan) => formatCount(plan.monthlyCredits)}
                  </Row>
                  <Row label={t('compare.images')}>
                    {(plan) =>
                      t('compare.imagesValue', {
                        n: formatCount(imagesPerMonth(plan.monthlyCredits)),
                      })
                    }
                  </Row>
                  <SameRow label={t('compare.grant')} value={t('compare.grantValue')} />
                  <SameRow label={t('compare.expiry')} value={t('compare.expiryValue')} />
                  <Row label={t('compare.concurrency')}>
                    {(plan) => t('compare.concurrencyValue', { n: plan.concurrency })}
                  </Row>
                  <SameRow label={t('compare.billing')} value={t('compare.billingValue')} />

                  <GroupLabel label={t('compare.groupCreate')} />
                  <SameRow label={t('compare.imageVideo')} value={t('compare.imageVideoValue')} />
                  <SameRow label={t('compare.canvas')} value={t('compare.canvasValue')} />
                  <SameRow label={t('compare.agent')} value={t('compare.agentValue')} />
                  <SameRow label={t('compare.library')} value={t('compare.libraryValue')} />

                  <GroupLabel label={t('compare.groupSpend')} />
                  <SameRow label={t('compare.meter')} value={t('compare.meterValue')} />
                  <SameRow
                    label={t('compare.anchor')}
                    value={t('compare.anchorValue', { n: formatCount(GPT_IMAGE_2_CREDITS) })}
                  />
                  <SameRow label={t('compare.failure')} value={t('compare.failureValue')} />
                  <SameRow label={t('compare.order')} value={t('compare.orderValue')} />
                  <SameRow label={t('compare.estimate')} value={t('compare.estimateValue')} />
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 pb-20 sm:px-8">
          <h2 className="pricing-section font-semibold tracking-tight">{t('rules.title')}</h2>
          <div className="mt-8 grid gap-10 md:grid-cols-2">
            <Rule title={t('rules.meterTitle')} body={t('rules.meterBody')} />
            <Rule
              title={t('rules.bucketTitle')}
              body={t('rules.bucketBody', { rate: formatCount(RECHARGE_CREDITS_PER_YUAN) })}
            />
            <Rule title={t('rules.cycleTitle')} body={t('rules.cycleBody')} />
            <Rule title={t('rules.failureTitle')} body={t('rules.failureBody')} />
          </div>
          <div className="mt-10 max-w-3xl">
            <Rule
              title={t('rules.inviteTitle')}
              body={t('rules.inviteBody', { n: formatCount(REFERRAL_REGISTRATION_CREDITS) })}
            />
          </div>
        </section>

        <section id="recharge" className="scroll-mt-24 pb-20">
          <div className="mx-auto max-w-6xl px-5 sm:px-8">
            <h2 className="pricing-section font-semibold tracking-tight">{t('recharge.title')}</h2>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-white/60">
              {t('recharge.subtitle', { rate: formatCount(RECHARGE_CREDITS_PER_YUAN) })}
            </p>
            <div
              className="mt-8 grid gap-4 sm:grid-cols-3"
              role="radiogroup"
              aria-label={t('recharge.title')}
            >
              {RECHARGE_AMOUNTS_YUAN.map((yuan) => {
                const selected = rechargeYuan === yuan
                return (
                  <button // design-allow native-control: 定价页的切换和折叠不是工作台表单控件
                    key={yuan}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setRechargeYuan(yuan)}
                    className={`rounded-3xl border px-5 py-6 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pricing-lime)] ${
                      selected
                        ? 'border-[var(--pricing-lime)] bg-[var(--pricing-lime)]/10'
                        : 'border-white/10 bg-[var(--pricing-card)] hover:border-white/25'
                    }`}
                  >
                    <div className="text-sm text-white/50">¥{formatCount(yuan)}</div>
                    <div className="mt-3 pricing-pack font-semibold tracking-tight">
                      {t('recharge.credits', { n: formatCount(rechargeCredits(yuan)) })}
                    </div>
                    <div className="mt-2 text-sm text-white/45">{t('recharge.valid')}</div>
                  </button>
                )
              })}
            </div>
            <button // design-allow native-control: 定价页的切换和折叠不是工作台表单控件
              type="button"
              onClick={enter}
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
                      <p id={panelId} className="max-w-2xl pb-4 text-sm leading-7 text-white/60">
                        {t(item.a)}
                      </p>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </div>
        </section>

        <section className="border-t border-white/10">
          <div className="mx-auto max-w-6xl px-5 py-20 text-center sm:px-8">
            <h2 className="pricing-close font-semibold tracking-tight">{t('close.title')}</h2>
            <p className="mx-auto mt-4 max-w-lg text-sm leading-7 text-white/60">
              {t('close.body')}
            </p>
            <button // design-allow native-control: 定价页的切换和折叠不是工作台表单控件
              type="button"
              onClick={enter}
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
              href="/"
              onClick={(event) => {
                event.preventDefault()
                leave()
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
  cycle,
  unit,
  onUpgrade,
}: {
  plan: PricingPlan
  cycle: BillingCycle
  unit: string
  onUpgrade: () => void
}) {
  const { t } = useTranslation('pricing')
  const price = plan.prices[cycle]
  const payable = effectivePriceCents(price)
  const monthly = monthlyEquivalentCents(payable, cycle)
  const discounted = payable < price.originalCents
  return (
    <article
      className={`relative flex h-full flex-col rounded-3xl border p-5 ${
        plan.featured
          ? 'border-[var(--pricing-lime)] bg-[var(--pricing-featured)]'
          : 'border-white/10 bg-[var(--pricing-card)]'
      }`}
    >
      {plan.featured ? (
        <span className="absolute -top-3 right-5 rounded-full bg-[var(--pricing-lime)] px-2.5 py-1 pricing-badge font-semibold text-[var(--pricing-ink-strong)]">
          {t('plan.featured')}
        </span>
      ) : null}
      <h2 className="pricing-name font-semibold">{t(PLAN_NAME[plan.id])}</h2>
      <p className="mt-1 text-sm text-white/50">{t(PLAN_TAGLINE[plan.id])}</p>
      <p className="mt-5 min-h-5 text-sm text-white/40 line-through">
        {discounted ? `${money(price.originalCents)}${unit}` : null}
      </p>
      <p className="mt-1 flex items-end gap-1" aria-live="polite">
        <span className="pricing-price font-semibold tracking-tight">{money(payable)}</span>
        <span className="pb-1.5 text-sm text-white/50">{unit}</span>
      </p>
      {cycle === 1 ? null : (
        <p className="mt-2 text-sm text-white/45">
          {t('plan.equivalent', { amount: yuanText(monthly) })}
        </p>
      )}
      <button // design-allow native-control: 定价页的切换和折叠不是工作台表单控件
        type="button"
        onClick={onUpgrade}
        className={`mt-4 h-11 w-full rounded-full text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pricing-lime)] ${
          plan.featured
            ? 'bg-[var(--pricing-lime)] text-[var(--pricing-ink-strong)] hover:bg-[var(--pricing-lime-hover)]'
            : 'bg-white text-[var(--pricing-ink)] hover:bg-[var(--pricing-hover)]'
        }`}
      >
        {t('plan.upgrade')}
      </button>
      <ul className="mt-6 space-y-3 border-t border-white/10 pt-5 text-sm">
        <Feature>{t('plan.monthlyCredits', { n: formatCount(plan.monthlyCredits) })}</Feature>
        <Feature>
          {t('plan.images', { n: formatCount(imagesPerMonth(plan.monthlyCredits)) })}
        </Feature>
        <Feature>{t('plan.concurrency', { n: plan.concurrency })}</Feature>
        <Feature>{t('plan.studio')}</Feature>
      </ul>
      <p className="mt-5 text-sm leading-6 text-white/40">
        {t('plan.grant')}
        <br />
        {t('plan.once')}
      </p>
    </article>
  )
}

function Feature({ children }: { children: string }) {
  return (
    <li className="flex gap-2">
      <Icon name="check" className="mt-0.5 shrink-0 text-white/70" />
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

function GroupLabel({ label }: { label: string }) {
  return (
    <tr>
      <th
        colSpan={1 + PRICING_PLANS.length}
        className="bg-white/[0.03] px-5 pb-2 pt-8 text-left text-xs font-medium text-white/40"
      >
        {label}
      </th>
    </tr>
  )
}

function Row({ label, children }: { label: string; children: (plan: PricingPlan) => string }) {
  return (
    <tr className="border-t border-white/[0.08]">
      <th className="sticky left-0 bg-[var(--pricing-panel)] px-5 py-3.5 text-left font-normal text-white/70">
        {label}
      </th>
      {PRICING_PLANS.map((plan) => (
        <td key={plan.id} className="px-4 py-3.5 text-center text-white/80">
          {children(plan)}
        </td>
      ))}
    </tr>
  )
}

function SameRow({ label, value }: { label: string; value: string }) {
  return <Row label={label}>{() => value}</Row>
}

function PriceRow({ label, cycle }: { label: string; cycle: BillingCycle }) {
  return <Row label={label}>{(plan) => money(effectivePriceCents(plan.prices[cycle]))}</Row>
}

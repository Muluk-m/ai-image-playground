import { useEffect, useState } from 'react'
import { Button } from '../../../web/src/components/ui/button'
import { Icon } from '../../../web/src/components/ui/icon'
import { saveSiteDraft } from '../../../web/src/lib/siteDraft'
import { editions, type Locale } from '../catalog'
import { rememberSiteLocale } from '../localeSelection'
import {
  CASE_GROUPS,
  type CaseGroup,
  caseHref,
  featureCards,
  MARK,
  marketingCopy,
  showcaseCases,
  starterPrompts,
} from '../marketing'
import { ContactModal } from './ContactModal'

const BAND = 'border-t border-dashed border-border px-6 py-14'
const TAB =
  'h-7 rounded-md px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const TAB_ON = 'bg-primary/15 text-primary hover:bg-primary/15 hover:text-primary'
const CONTACT_HASH = '#contact'
const CONTACT_HISTORY_KEY = 'muvloomContact'

function contactHistoryState(open: boolean): Record<string, unknown> {
  const current = window.history.state
  const base = current && typeof current === 'object' ? current : {}
  return { ...base, [CONTACT_HISTORY_KEY]: open }
}

function contactEntryOpen(): boolean {
  return window.history.state?.[CONTACT_HISTORY_KEY] === true
}

function pageUrl(hash: string): string {
  return window.location.pathname + window.location.search + hash
}

export function MarketingHome({ locale, start }: { locale: Locale; start: () => void }) {
  const text = marketingCopy[locale]
  const [prompt, setPrompt] = useState('')
  const [group, setGroup] = useState<CaseGroup | null>(null)
  const [contactOpen, setContactOpen] = useState(false)
  const home = locale === 'en' ? '/en/' : '/'
  const cases = showcaseCases(locale).filter((item) => !group || item.group === group)
  const begin = () => {
    saveSiteDraft(prompt)
    start()
  }
  const openContact = (event: { preventDefault(): void }) => {
    event.preventDefault()
    if (contactEntryOpen()) {
      setContactOpen(true)
      return
    }
    // 压一条历史，浏览器后退先关掉弹窗，而不是离开首页。
    window.history.pushState(contactHistoryState(true), '', pageUrl(CONTACT_HASH))
    setContactOpen(true)
  }
  const closeContact = () => {
    if (contactEntryOpen()) {
      window.history.back()
      return
    }
    setContactOpen(false)
  }

  // 带 #contact 打开就弹出联系方式。落地时先把当前记录改成「关着」，再压一条「开着」，
  // 这样后退先关弹窗。页内跳到 #contact 时，浏览器已经压过记录，只补上标记。
  // 关闭按钮走 history.back()，不额外留一条记录。
  useEffect(() => {
    if (window.location.hash === CONTACT_HASH && !contactEntryOpen()) {
      window.history.replaceState(contactHistoryState(false), '', pageUrl(''))
      window.history.pushState(contactHistoryState(true), '', pageUrl(CONTACT_HASH))
    }
    const sync = () => {
      if (window.location.hash === CONTACT_HASH && !contactEntryOpen())
        window.history.replaceState(contactHistoryState(true), '', pageUrl(CONTACT_HASH))
      setContactOpen(contactEntryOpen())
    }
    sync()
    window.addEventListener('popstate', sync)
    window.addEventListener('hashchange', sync)
    return () => {
      window.removeEventListener('popstate', sync)
      window.removeEventListener('hashchange', sync)
    }
  }, [])

  return (
    <main className="mkt" data-locale={locale}>
      <div className="mkt-frame">
        <nav className="mkt-nav">
          <a className="mkt-brand" href={home}>
            <img src={MARK} width={26} height={26} alt="" />
            {text.brand}
          </a>
          <div className="mkt-links">
            <a href="#cases">{text.nav.cases}</a>
            <a href="#features">{text.nav.features}</a>
            <a href="/explore">{text.nav.inspiration}</a>
            <a href={editions[locale].root}>{text.nav.guide}</a>
            <a href="/pricing">{text.nav.pricing}</a>
          </div>
          <div className="mkt-nav-end">
            <a className="mkt-nav-pricing" href="/pricing">
              {text.nav.pricing}
            </a>
            <Button asChild variant="ghost" size="sm">
              <a
                href={locale === 'en' ? '/' : '/en/'}
                hrefLang={locale === 'en' ? 'zh-CN' : 'en'}
                onClick={() => rememberSiteLocale(locale === 'en' ? 'zh-CN' : 'en')}
              >
                {locale === 'en' ? '中文' : 'EN'}
              </a>
            </Button>
            <Button variant="outline" size="sm" onClick={start}>
              {text.nav.signIn}
            </Button>
          </div>
        </nav>

        <header className="mkt-hero">
          <h1 className="mkt-title">{text.hero.title}</h1>
          <p className="mx-auto mt-3 max-w-2xl text-sm text-muted-foreground">{text.hero.body}</p>
          <form
            className="mkt-composer"
            onSubmit={(event) => {
              event.preventDefault()
              begin()
            }}
          >
            <textarea
              className="mkt-input"
              value={prompt}
              rows={3}
              maxLength={4000}
              placeholder={text.hero.placeholder}
              aria-label={text.hero.placeholder}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  begin()
                }
              }}
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="mkt-pill">
                <Icon name="agentActivity" size="xs" />
                {text.hero.mode}
              </span>
              <span className="mkt-pill">
                <Icon name="model" size="xs" />
                {text.hero.model}
              </span>
              <Button type="submit" className="ml-auto rounded-lg font-semibold">
                {text.hero.start}
                <Icon name="arrowRight" size="xs" />
              </Button>
            </div>
          </form>
          <div className="mx-auto mt-4 flex mkt-chips flex-wrap justify-center gap-2">
            {starterPrompts(locale).map((item) => (
              <button
                key={item.id}
                type="button"
                className="mkt-chip"
                aria-pressed={prompt === item.prompt}
                onClick={() => setPrompt(item.prompt)}
              >
                <img src={item.image} alt="" width={24} height={24} loading="lazy" />
                {item.title}
              </button>
            ))}
          </div>
          <p className="mt-3.5 text-xs text-muted-foreground">{text.hero.note}</p>
        </header>

        <section className={`${BAND} mt-14`} id="cases">
          <div className="mkt-bandhead">
            <div>
              <h2 className="text-headline font-semibold">{text.cases.title}</h2>
              <p className="mt-1.5 text-sm text-muted-foreground">{text.cases.lead}</p>
            </div>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                className={`${TAB} ${group === null ? TAB_ON : ''}`}
                aria-pressed={group === null}
                onClick={() => setGroup(null)}
              >
                {text.cases.all}
              </button>
              {CASE_GROUPS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`${TAB} ${group === id ? TAB_ON : ''}`}
                  aria-pressed={group === id}
                  onClick={() => setGroup(id)}
                >
                  {text.cases.groups[id]}
                </button>
              ))}
            </div>
          </div>
          <div className="mkt-grid4">
            {cases.map((item) => (
              <a key={item.id} className="mkt-case" href={caseHref(item.id)}>
                <span className="mkt-tile">
                  <img src={item.image} alt={item.title} loading="lazy" decoding="async" />
                  <span className="mkt-same">
                    <Icon name="reuse" size="xs" />
                    {text.cases.same}
                  </span>
                </span>
                <span className="mt-2 flex justify-between gap-2 px-0.5">
                  <b className="truncate text-body-sm font-medium">{item.title}</b>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {text.cases.groups[item.group]}
                  </span>
                </span>
              </a>
            ))}
          </div>
        </section>

        <section className={BAND} id="features">
          <div className="mkt-bandhead">
            <div>
              <h2 className="text-headline font-semibold">{text.featuresTitle}</h2>
              <p className="mt-1.5 text-sm text-muted-foreground">{text.featuresNote}</p>
            </div>
          </div>
          <div className="mkt-grid3">
            {featureCards(locale).map((item, index) => (
              <article key={item.image} className="mkt-feat">
                <div className="mkt-shot">
                  <img src={item.image} alt={item.title} loading="lazy" decoding="async" />
                </div>
                <div className="px-4 pb-4 pt-3.5">
                  <h3 className="text-title font-medium">
                    <span className="mkt-num">{String(index + 1).padStart(2, '0')}</span>
                    {item.title}
                  </h3>
                  <p className="mt-1 text-body-sm text-muted-foreground">{item.body}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className={`${BAND} text-center`}>
          <h2 className="text-headline font-semibold">{text.end.title}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{text.end.body}</p>
          <Button variant="outline" size="lg" className="mt-5 px-5" onClick={start}>
            {text.end.start}
            <Icon name="arrowRight" size="xs" />
          </Button>
        </section>

        <footer className="mkt-foot">
          <div>
            <a className="mkt-brand" href={home}>
              <img src={MARK} width={26} height={26} alt="" />
              {text.brand}
            </a>
            <p className="mt-2.5 text-xs text-muted-foreground">{text.footer.tagline}</p>
            <p className="mt-6 text-xs text-muted-foreground">{text.footer.copy}</p>
          </div>
          <div>
            <h4>{text.footer.product}</h4>
            <a href="#cases">{text.nav.cases}</a>
            <a href="#features">{text.nav.features}</a>
            <a href="/explore">{text.nav.inspiration}</a>
            <a href="/pricing">{text.nav.pricing}</a>
          </div>
          <div id="contact">
            <h4>{text.footer.help}</h4>
            <a href={editions[locale].root}>{text.nav.guide}</a>
            <a href="#contact" onClick={openContact}>
              {text.footer.contact}
            </a>
          </div>
          <div>
            <h4>{text.footer.legal}</h4>
            <a href="/terms">{text.footer.terms}</a>
            <a href="/privacy">{text.footer.privacy}</a>
          </div>
        </footer>
      </div>
      <ContactModal open={contactOpen} locale={locale} onClose={closeContact} />
    </main>
  )
}

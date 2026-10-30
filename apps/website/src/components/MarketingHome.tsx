import { useEffect, useState } from 'react'
import { editions, type Locale } from '../catalog'
import { rememberSiteLocale } from '../localeSelection'
import { caseRows, HOME_IMAGES, MARK, marketingCopy } from '../marketing'
import { ContactModal } from './ContactModal'

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
  const [contactOpen, setContactOpen] = useState(false)
  const home = locale === 'en' ? '/en/' : '/'
  const guide = editions[locale].root
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
      <div className="mkt-wrap">
        <nav className="mkt-nav">
          <a className="mkt-brand" href={home}>
            <img src={MARK} width={24} height={24} alt="" />
            {text.brand}
          </a>
          <div className="mkt-links">
            <a href="#cases">{text.nav.cases}</a>
            <a href="#features">{text.nav.features}</a>
            <a href="/explore">{text.nav.inspiration}</a>
            <a href={guide}>{text.nav.guide}</a>
            <a href="/pricing">{text.nav.pricing}</a>
          </div>
          <div className="mkt-nav-end">
            <a className="mkt-nav-pricing" href="/pricing">
              {text.nav.pricing}
            </a>
            <a
              href={locale === 'en' ? '/' : '/en/'}
              hrefLang={locale === 'en' ? 'zh-CN' : 'en'}
              onClick={() => rememberSiteLocale(locale === 'en' ? 'zh-CN' : 'en')}
            >
              {locale === 'en' ? '中文' : 'EN'}
            </a>
            <button type="button" className="mkt-signin" onClick={start}>
              {text.nav.signIn}
            </button>
          </div>
        </nav>

        <header className="mkt-hero">
          <div>
            <h1 className="mkt-title">
              {text.hero.title[0]}
              <br />
              {text.hero.title[1]}
            </h1>
            <p className="mkt-lead">{text.hero.body}</p>
            <div className="mkt-cta">
              <button type="button" className="mkt-btn-primary" onClick={start}>
                {text.hero.start}
              </button>
              <a className="mkt-sec" href={guide}>
                {text.hero.guide}
              </a>
            </div>
          </div>
          <div className="mkt-shot">
            <img src={HOME_IMAGES.hero} width={1560} height={1200} alt={text.hero.shotAlt} />
          </div>
        </header>
      </div>

      <section className="mkt-band" id="cases">
        <div className="mkt-wrap">
          <div className="mkt-intro">
            <h2>{text.cases.title}</h2>
          </div>
          {caseRows(locale).map((row, index) => (
            <article key={row.id} className={`mkt-task${index % 2 === 1 ? ' flip' : ''}`}>
              <div className={`mkt-imgs ${row.figures.length === 4 ? 'four' : 'two'}`}>
                {row.figures.map((figure) => (
                  <figure key={figure.src}>
                    <img
                      src={figure.src}
                      alt={figure.alt}
                      loading="lazy"
                      decoding="async"
                      width={row.figures.length === 4 ? 420 : 640}
                      height={row.figures.length === 4 ? 420 : 853}
                    />
                    <figcaption>{figure.caption}</figcaption>
                  </figure>
                ))}
              </div>
              <div className="mkt-text">
                <h3>{row.title}</h3>
                <p className="mkt-said">
                  <span className="mkt-said-k">{text.cases.input}</span>
                  {row.prompt}
                  {row.tail ? <span className="mkt-nw">{row.tail}</span> : null}
                </p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <div className="mkt-wrap">
        <section className="mkt-facts" id="features">
          <h2>{text.features.title}</h2>
          <dl>
            {text.features.rows.map(([term, detail]) => (
              <div key={term}>
                <dt>{term}</dt>
                <dd>{detail}</dd>
              </div>
            ))}
          </dl>
        </section>
        <div className="mkt-end">
          <p>{text.pricing.line}</p>
          <a href="/pricing">{text.pricing.link} →</a>
        </div>
      </div>

      <footer className="mkt-foot">
        <div className="mkt-wrap mkt-fgrid">
          <div>
            <a className="mkt-brand" href={home}>
              <img src={MARK} width={24} height={24} alt="" />
              {text.brand}
            </a>
            <p className="mkt-tag">{text.footer.tagline}</p>
            <p className="mkt-copy">{text.footer.copy}</p>
          </div>
          <div className="mkt-col">
            <h4>{text.footer.product}</h4>
            <a href="#cases">{text.nav.cases}</a>
            <a href="#features">{text.nav.features}</a>
            <a href="/explore">{text.nav.inspiration}</a>
            <a href="/pricing">{text.nav.pricing}</a>
          </div>
          <div className="mkt-col" id="contact">
            <h4>{text.footer.help}</h4>
            <a href={guide}>{text.nav.guide}</a>
            <a href="#contact" onClick={openContact}>
              {text.footer.contact}
            </a>
          </div>
          <div className="mkt-col">
            <h4>{text.footer.legal}</h4>
            <a href="/terms">{text.footer.terms}</a>
            <a href="/privacy">{text.footer.privacy}</a>
          </div>
        </div>
      </footer>
      <ContactModal open={contactOpen} locale={locale} onClose={closeContact} />
    </main>
  )
}

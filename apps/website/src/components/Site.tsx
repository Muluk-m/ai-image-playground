import { type CSSProperties, lazy, Suspense, useEffect, useRef, useState } from 'react'
import Overlay from '../../../web/src/components/patterns/Overlay'
import { Button } from '../../../web/src/components/ui/button'
import { Icon } from '../../../web/src/components/ui/icon'
import { alternatePage, copy, editions, type Locale, type SitePage, scenarios } from '../catalog'
import { structuredData } from '../guideData'
import { Guide } from './Guide'

const Auth = lazy(() => import('./SiteAuth'))
const hero = '/website-assets/creator-hero.webp'
const board = '/website-assets/creator-storyboard.webp'
export function Brand({ locale }: { locale: Locale }) {
  return (
    <span className="site-brand">
      <img src="/brand/muvloom-mark.svg" width={28} height={28} alt="" />
      {copy[locale].brand}
    </span>
  )
}
export function Site({ page }: { page: SitePage }) {
  const text = copy[page.locale]
  const [login, setLogin] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [art, setArt] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  const start = () => setLogin(true)
  const navigation = (
    <nav className="site-nav" aria-label={text.brand}>
      <a href={page.locale === 'en' ? '/en/' : '/'}>
        <Brand locale={page.locale} />
      </a>
      <div className="site-nav-links">
        <a
          href={
            page.kind === 'home' ? '#features' : `${page.locale === 'en' ? '/en/' : '/'}#features`
          }
        >
          {text.explore}
        </a>
        <a href="/pricing">{text.pricing}</a>
        <a href={editions[page.locale].root}>{text.guide}</a>
      </div>
      <div className="site-nav-actions">
        <a
          href={alternatePage(page).path}
          hrefLang={alternatePage(page).locale}
          className="site-language"
        >
          {page.locale === 'en' ? '中文' : 'EN'}
        </a>
        <Button onClick={start}>
          {text.start}
          <Icon name="arrowRight" />
        </Button>
      </div>
    </nav>
  )
  return (
    <div className="marketing-site" data-locale={page.locale}>
      {page.kind === 'home' ? (
        <Home
          locale={page.locale}
          start={start}
          navigation={navigation}
          showArt={() => setArt(true)}
        />
      ) : (
        <>
          {page.kind !== 'login' ? navigation : null}
          {page.kind === 'guide' ? (
            <Guide page={page} />
          ) : page.kind === 'scenario' ? (
            <main className="site-scenario">
              <span className="site-eyebrow">MUVLOOM STUDIO</span>
              <h1>{text[page.scenario!]}</h1>
              <p>{text[`${page.scenario!}Body`]}</p>
              <Button onClick={start}>
                {text.start}
                <Icon name="arrowRight" />
              </Button>
              <img
                src={page.scenario === 'canvas' ? board : hero}
                width={1536}
                height={1024}
                alt={text[page.scenario!]}
              />
              <a
                href={`${editions[page.locale].root}${page.scenario === 'canvas' ? 'canvas' : 'create'}/`}
              >
                {text.learn} →
              </a>
            </main>
          ) : null}
        </>
      )}
      {page.kind === 'login' && !mounted ? (
        <main className="site-login-pending">
          <Brand locale={page.locale} />
          <h1>{text.loginTitle}</h1>
          <p>{text.loading}</p>
          <a href="/image">{text.start} →</a>
        </main>
      ) : null}
      {mounted && (page.kind === 'home' || page.kind === 'login' || login) ? (
        <Suspense
          fallback={
            <p className="site-connect" role="status">
              {text.loading}
            </p>
          }
        >
          <Auth
            locale={page.locale}
            page={page.kind}
            open={login}
            onClose={() => setLogin(false)}
          />
        </Suspense>
      ) : null}
      {page.kind !== 'login' ? (
        <footer className="site-footer">
          <Brand locale={page.locale} />
          <div>
            <a href={editions[page.locale].root}>{text.guide}</a>
            <a href="/pricing">{text.pricing}</a>
            <a href="/terms">{text.terms}</a>
            <a href="/privacy">{text.privacy}</a>
          </div>
          <span>© Muvloom</span>
        </footer>
      ) : null}
      {art ? (
        <Overlay onClose={() => setArt(false)} label={text.view}>
          <section className="site-art-dialog">
            <Button variant="ghost" onClick={() => setArt(false)}>
              {text.close}
              <Icon name="close" />
            </Button>
            <img src={board} alt={text.storyboard} />
          </section>
        </Overlay>
      ) : null}
      <StructuredData page={page} />
    </div>
  )
}
function Home({
  locale,
  start,
  navigation,
  showArt,
}: {
  locale: Locale
  start: () => void
  navigation: React.ReactNode
  showArt: () => void
}) {
  const text = copy[locale],
    story = useRef<HTMLElement>(null)
  const [scene, setScene] = useState(0)
  useEffect(() => {
    const container = story.current
    if (!container) return
    const cover = container.querySelector<HTMLElement>('.site-hero')!
    const query = matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0
    const clamp = (n: number) => Math.max(0, Math.min(1, n))
    const ease = (n: number) => {
      n = clamp(n)
      return n * n * (3 - 2 * n)
    }
    const update = () => {
      frame = 0
      const p = query.matches
        ? 0
        : clamp(
            -container.getBoundingClientRect().top /
              Math.max(1, container.offsetHeight - cover.offsetHeight),
          )
      cover.style.setProperty('--morph', String(ease((p - 0.06) / 0.86)))
      cover.style.setProperty('--out', String(ease(p / 0.35)))
      cover.style.setProperty('--caption', String(ease((p - 0.48) / 0.42)))
      for (const el of cover.querySelectorAll<HTMLElement>('[data-intro]')) el.inert = p > 0.35
      const caption = cover.querySelector<HTMLElement>('.site-workflow')!
      caption.inert = p < 0.6
      for (const el of document.querySelectorAll<HTMLElement>('.site-story-panel'))
        el.style.setProperty(
          '--entry',
          String(
            query.matches
              ? 1
              : ease((innerHeight - el.getBoundingClientRect().top) / (innerHeight * 0.7)),
          ),
        )
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    const pointer = (e: PointerEvent) => {
      if (query.matches || e.pointerType === 'touch') return
      const rect = cover.getBoundingClientRect()
      cover.style.setProperty('--mx', String(((e.clientX - rect.left) / rect.width) * 2 - 1))
      cover.style.setProperty('--my', String(((e.clientY - rect.top) / rect.height) * 2 - 1))
    }
    const reset = () => {
      cover.style.setProperty('--mx', '0')
      cover.style.setProperty('--my', '0')
    }
    addEventListener('scroll', schedule, { passive: true })
    addEventListener('resize', schedule)
    query.addEventListener('change', schedule)
    cover.addEventListener('pointermove', pointer)
    cover.addEventListener('pointerleave', reset)
    update()
    return () => {
      cancelAnimationFrame(frame)
      removeEventListener('scroll', schedule)
      removeEventListener('resize', schedule)
      query.removeEventListener('change', schedule)
      cover.removeEventListener('pointermove', pointer)
      cover.removeEventListener('pointerleave', reset)
    }
  }, [])
  return (
    <main>
      <section className="site-scroll-story" ref={story}>
        <div className="site-hero">
          <div className="site-visual">
            <img
              className="site-cover"
              src={scene === 0 ? hero : board}
              width={1536}
              height={1024}
              fetchPriority="high"
              alt={scene === 0 ? text.character : text.boards}
            />
            <div className="site-shade" />
            <span className="site-art-credit">MUVLOOM ORIGINAL</span>
          </div>
          <div data-intro>{navigation}</div>
          <div className="site-hero-copy" data-intro>
            <span className="site-eyebrow">{text.kicker}</span>
            <h1>{text.title}</h1>
            <Button className="site-hero-action" onClick={start}>
              {text.start}
              <span>
                <Icon name="arrowRight" />
              </span>
            </Button>
          </div>
          <div className="site-picker" data-intro>
            {[hero, board].map((src, i) => (
              <Button
                variant="ghost"
                key={src}
                aria-pressed={scene === i}
                onClick={() => setScene(i)}
                aria-label={i === 0 ? text.character : text.boards}
              >
                <img src={src} width={88} height={54} alt="" />
                <span>0{i + 1}</span>
              </Button>
            ))}
            <span>{scene === 0 ? text.character : text.boards}</span>
          </div>
          <div className="site-hero-bottom" data-intro>
            <span>CHARACTERS. WORLDS. STORIES.</span>
            <a href="#features">{text.scroll} ↓</a>
          </div>
          <div className="site-workflow">
            <span>{text.idea}</span>
            <h2>{text.world}</h2>
            <Button variant="link" onClick={start}>
              {text.start} ↗
            </Button>
          </div>
        </div>
      </section>
      <section className="site-features" id="features">
        <header>
          <div>
            <span className="site-eyebrow">ONE CHARACTER. ENDLESS STORIES.</span>
            <h2>{text.storyboard}</h2>
          </div>
          <span className="site-index">01 — 03 / STORYBOARD</span>
        </header>
        <div className="site-story-grid">
          {text.beats.map((beat, i) => (
            <article
              className="site-story-panel"
              key={beat}
              style={{ '--panel-index': i } as CSSProperties}
            >
              <Button
                variant="ghost"
                className="site-panel-art"
                onClick={showArt}
                aria-label={`${text.view} — ${beat}`}
              >
                <img src={board} alt={beat} loading="lazy" width={1536} height={1024} />
                <span>
                  <Icon name="arrowRight" />
                </span>
              </Button>
              <div className="site-panel-label">
                <span>
                  0{i + 1} / {beat}
                </span>
                <small>{['IMAGINE', 'EXPLORE', 'BECOME'][i]}</small>
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="site-scenarios" aria-label={text.scenarios}>
        {scenarios.map((id) => (
          <a href={`${locale === 'en' ? '/en' : ''}/create/${id}/`} key={id}>
            <span>{text[id]}</span>
            <Icon name="arrowRight" />
          </a>
        ))}
      </section>
      <section className="site-closing">
        <span className="site-eyebrow">MAKE SOMETHING ONLY YOU CAN.</span>
        <h2>{text.next}</h2>
        <Button onClick={start}>
          {text.start}
          <Icon name="arrowRight" />
        </Button>
      </section>
    </main>
  )
}
function StructuredData({ page }: { page: SitePage }) {
  const origin = import.meta.env.VITE_PUBLIC_ORIGIN
  if (!origin || page.kind === 'login') return null
  const data = structuredData(page, origin)
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  )
}

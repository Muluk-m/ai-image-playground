import { lazy, Suspense, useEffect, useState } from 'react'
import { Button } from '../../../web/src/components/ui/button'
import { Icon } from '../../../web/src/components/ui/icon'
import { siteAssetUrl } from '../../../web/src/features/guide/content/siteAssets'
import { initTheme, setThemeChoice } from '../../../web/src/theme'
import { alternatePage, copy, editions, guidePath, type Locale, type SitePage } from '../catalog'
import { structuredData } from '../guideData'
import { rememberSiteLocale } from '../localeSelection'
import { marketingCopy } from '../marketing'
import { AuthBoundary } from './AuthBoundary'
import { Guide, GuideMovedPage } from './Guide'
import { MarketingHome } from './MarketingHome'

function toggleSiteTheme() {
  setThemeChoice(document.documentElement.classList.contains('dark') ? 'light' : 'dark')
}

const Auth = lazy(() => import('./SiteAuth'))
const hero = siteAssetUrl('/website-assets/creator-hero.webp')
const board = siteAssetUrl('/website-assets/creator-storyboard.webp')
export function Brand({ locale }: { locale: Locale }) {
  return (
    <span className="site-brand">
      <img src={siteAssetUrl('/brand/muvloom-mark.svg')} width={28} height={28} alt="" />
      {copy[locale].brand}
    </span>
  )
}
export function Site({ page }: { page: SitePage }) {
  const text = copy[page.locale]
  const [login, setLogin] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => {
    setMounted(true)
    return initTheme()
  }, [])
  useEffect(() => {
    if (!menuOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [menuOpen])
  const start = () => setLogin(true)
  const loginPending = (
    <main className="site-login-pending">
      <Brand locale={page.locale} />
      <h1>{text.loginTitle}</h1>
      <p role="status">{text.loading}</p>
      <a href="/image">{text.start} →</a>
    </main>
  )
  const navigation = (
    <>
      <nav className="site-nav" aria-label={text.brand}>
        <a href={page.locale === 'en' ? '/en/' : '/'}>
          <Brand locale={page.locale} />
        </a>
        <div className="site-nav-links">
          <a href="/explore">{text.explore}</a>
          <a href="/pricing">{text.pricing}</a>
          <a href={editions[page.locale].root}>{text.guide}</a>
        </div>
        <div className="site-nav-actions">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="mkt-theme"
            aria-label={marketingCopy[page.locale].nav.theme}
            onClick={toggleSiteTheme}
          >
            <Icon name="light" className="sun" />
            <Icon name="dark" className="moon" />
          </Button>
          <a
            href={alternatePage(page).path}
            hrefLang={alternatePage(page).locale}
            aria-label={page.locale === 'en' ? 'Switch to Chinese' : '切换到英文'}
            className="site-language"
            onClick={() => rememberSiteLocale(alternatePage(page).locale)}
          >
            {page.locale === 'en' ? '中文' : 'EN'}
          </a>
          <Button onClick={start}>
            {text.start}
            <Icon name="arrowRight" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="site-menu-btn"
            aria-expanded={menuOpen}
            aria-controls="site-mobile-menu"
            aria-label={
              menuOpen
                ? page.locale === 'en'
                  ? 'Close navigation menu'
                  : '关闭导航菜单'
                : page.locale === 'en'
                  ? 'Open navigation menu'
                  : '打开导航菜单'
            }
            onClick={() => setMenuOpen((prev) => !prev)}
          >
            <Icon name={menuOpen ? 'close' : 'list'} />
          </Button>
        </div>
      </nav>
      {menuOpen ? (
        <div id="site-mobile-menu" className="site-mobile-menu">
          <a href="/explore" onClick={() => setMenuOpen(false)}>
            {text.explore}
          </a>
          <a href="/pricing" onClick={() => setMenuOpen(false)}>
            {text.pricing}
          </a>
          <a href={editions[page.locale].root} onClick={() => setMenuOpen(false)}>
            {text.guide}
          </a>
        </div>
      ) : null}
    </>
  )
  return (
    <div className="marketing-site" data-locale={page.locale}>
      {page.kind === 'home' ? (
        <MarketingHome locale={page.locale} start={start} />
      ) : (
        <>
          {page.kind !== 'login' ? navigation : null}
          {page.kind === 'guide' ? (
            <Guide page={page} />
          ) : page.kind === 'moved' ? (
            <GuideMovedPage page={page} />
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
                href={guidePath(
                  editions[page.locale],
                  page.scenario === 'canvas'
                    ? 'canvas/basics'
                    : page.scenario === 'video'
                      ? 'create/video'
                      : 'create/settings',
                  'create/composer',
                )}
              >
                {text.learn} →
              </a>
            </main>
          ) : null}
        </>
      )}
      {page.kind === 'login' && !mounted ? loginPending : null}
      {mounted && (page.kind === 'home' || page.kind === 'login' || login) ? (
        <AuthBoundary
          locale={page.locale}
          visible={login || page.kind === 'login'}
          onClose={() => {
            if (page.kind === 'login') location.assign(page.locale === 'en' ? '/en/' : '/')
            else setLogin(false)
          }}
        >
          <Suspense
            fallback={
              page.kind === 'login' ? (
                loginPending
              ) : login ? (
                <p className="site-connect" role="status">
                  {text.loading}
                </p>
              ) : null
            }
          >
            <Auth
              locale={page.locale}
              page={page.kind}
              open={login}
              onOpen={start}
              onClose={() => setLogin(false)}
            />
          </Suspense>
        </AuthBoundary>
      ) : null}
      {page.kind !== 'login' && page.kind !== 'home' ? (
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
      <StructuredData page={page} />
    </div>
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

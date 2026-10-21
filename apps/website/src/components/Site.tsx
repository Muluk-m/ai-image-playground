import { lazy, Suspense, useEffect, useState } from 'react'
import { Button } from '../../../web/src/components/ui/button'
import { Icon } from '../../../web/src/components/ui/icon'
import { alternatePage, copy, editions, type Locale, type SitePage } from '../catalog'
import { structuredData } from '../guideData'
import { AuthBoundary } from './AuthBoundary'
import { Guide } from './Guide'
import { MarketingHome } from './MarketingHome'

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
        <MarketingHome locale={page.locale} start={start} />
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
              <p className="site-connect" role="status">
                {text.loading}
              </p>
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

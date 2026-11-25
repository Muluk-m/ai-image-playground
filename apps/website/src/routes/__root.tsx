import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
} from '@tanstack/react-router'
import { siteAssetUrl } from '../../../web/src/features/guide/content/siteAssets'
import { THEME_BOOT_SCRIPT } from '../../../web/src/theme/bootScript'
import { copy, editions, findPage, localeFromPath } from '../catalog'
import { Brand } from '../components/Site'
import { ROOT_LOCALE_SELECTION_SCRIPT } from '../localeSelection'
import { ROOT_SESSION_SELECTION_SCRIPT } from '../rootSessionSelection'
import cssUrl from '../site.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
    ],
    links: [
      { rel: 'stylesheet', href: cssUrl },
      { rel: 'icon', href: siteAssetUrl('/brand/muvloom-icon.svg') },
    ],
    scripts: [
      { children: THEME_BOOT_SCRIPT },
      { children: ROOT_SESSION_SELECTION_SCRIPT },
      { children: ROOT_LOCALE_SELECTION_SCRIPT },
    ],
  }),
  component: Document,
  notFoundComponent: NotFound,
})
function NotFound() {
  const path = useRouterState({ select: (state) => state.location.pathname })
  const locale = localeFromPath(path)
  const text = copy[locale]
  const home = locale === 'en' ? '/en/' : '/'
  return (
    <div className="marketing-site" data-locale={locale}>
      <nav className="site-nav" aria-label={text.brand}>
        <a href={home}>
          <Brand locale={locale} />
        </a>
      </nav>
      <main className="site-missing">
        <p className="site-eyebrow">404</p>
        <h1>{text.notFound}</h1>
        <div className="site-missing-actions">
          <a className="site-missing-primary" href={home}>
            {text.back}
          </a>
          <a className="site-missing-secondary" href={editions[locale].root}>
            {text.guide}
          </a>
        </div>
      </main>
    </div>
  )
}
function Document() {
  const path = useRouterState({ select: (state) => state.location.pathname })
  const locale = findPage(path)?.locale ?? localeFromPath(path)
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  )
}

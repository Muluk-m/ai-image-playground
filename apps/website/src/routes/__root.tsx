import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
} from '@tanstack/react-router'
import { THEME_BOOT_SCRIPT } from '../../../web/src/theme/bootScript'
import { copy, findPage, localeFromPath } from '../catalog'
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
      { rel: 'icon', href: '/brand/muvloom-icon.svg' },
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
  return (
    <main className="site-missing">
      <h1>{text.notFound}</h1>
      <a href={locale === 'en' ? '/en/' : '/'}>{text.back}</a>
    </main>
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

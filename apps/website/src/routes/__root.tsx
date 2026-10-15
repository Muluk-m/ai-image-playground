import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
} from '@tanstack/react-router'
import { THEME_BOOT_SCRIPT } from '../../../web/src/theme/bootScript'
import { copy, findPage } from '../catalog'
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
    scripts: [{ children: THEME_BOOT_SCRIPT }],
  }),
  component: Document,
  notFoundComponent: () => (
    <main className="site-missing">
      <h1>{copy['zh-CN'].notFound}</h1>
      <a href="/">返回官网 / Home</a>
    </main>
  ),
})
function Document() {
  const path = useRouterState({ select: (state) => state.location.pathname })
  return (
    <html lang={findPage(path)?.locale ?? 'zh-CN'} suppressHydrationWarning>
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

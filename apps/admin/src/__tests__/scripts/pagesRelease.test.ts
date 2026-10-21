import { readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { adminRoutePaths, expectedRouteCount, pagesRedirects } from '../../lib/pagesRedirects'

const adminRoot = resolve(__dirname, '../../..')
const root = resolve(adminRoot, '../..')
const { serveDist } = createRequire(import.meta.url)(join(root, 'scripts/pages-browser-smoke.cjs'))
const { verifyAdminPagesRelease, verifyPagesReleaseWithRetry } = await import(
  pathToFileURL(join(root, 'scripts/verify-pages-release.mjs')).href
)

const routeTree = `
export interface FileRoutesByFullPath {
  '/': typeof IndexRoute
  '/login': typeof LoginRoute
  '/users/$userId': typeof AuthedUsersUserIdRoute
  '/users/': typeof AuthedUsersIndexRoute
  '/billing/orders': typeof AuthedBillingOrdersRoute
}
export interface FileRoutesByTo {
  '/users': typeof AuthedUsersIndexRoute
}
`

describe('pagesRedirects', () => {
  it('lists every route explicitly and never falls back for assets', () => {
    const rules = pagesRedirects(adminRoutePaths(routeTree))
    expect(rules).toBe(
      [
        '# Generated from src/routeTree.gen.ts. Missing assets must remain 404.',
        '/login / 200',
        '/login/ / 200',
        '/users / 200',
        '/users/ / 200',
        '/billing/orders / 200',
        '/billing/orders/ / 200',
        '/users/:userId / 200',
        '/users/:userId/ / 200',
        '',
      ].join('\n'),
    )
    expect(rules).not.toMatch(/^\/\*/m)
    expect(rules).not.toMatch(/^\/assets/m)
    // Pages 会把 .html 目标规范化成跳转，深链会被 308 带走。
    expect(rules).not.toContain('.html')
  })

  it('covers every route in the generated tree', async () => {
    const source = await readFile(join(adminRoot, 'src/routeTree.gen.ts'), 'utf8')
    const rules = pagesRedirects(adminRoutePaths(source))
    for (const path of ['/login', '/overview', '/users', '/users/:userId', '/tasks/:taskId']) {
      expect(rules).toContain(`${path} / 200\n`)
    }
  })

  it('matches the route files, so a generator format change fails the build', async () => {
    const source = await readFile(join(adminRoot, 'src/routeTree.gen.ts'), 'utf8')
    const files = readdirSync(join(adminRoot, 'src/routes'), { recursive: true, encoding: 'utf8' })
    expect(adminRoutePaths(source)).toHaveLength(expectedRouteCount(files))
    expect(
      expectedRouteCount([
        '__root.tsx',
        '_authed.tsx',
        'index.tsx',
        'login.tsx',
        '_authed.users.index.tsx',
        '_authed.users.$userId.tsx',
        '_authed.billing.orders.route.tsx',
        '-helpers.ts',
        'login.lazy.tsx',
        'README.md',
      ]),
    ).toBe(5)
  })

  it('accepts either quote style and nested braces in the generated interface', () => {
    expect(
      adminRoutePaths(
        'export interface FileRoutesByFullPath {\n  "/": typeof A\n  "/x": { a: 1 }\n  \'/y\': typeof B\n}',
      ),
    ).toEqual(['/', '/x', '/y'])
  })

  it('refuses route trees it cannot express safely', () => {
    expect(() => adminRoutePaths('export const x = 1')).toThrow('FileRoutesByFullPath')
    expect(() => adminRoutePaths('export interface FileRoutesByFullPath {}')).toThrow(
      '没有任何路由',
    )
    expect(() => pagesRedirects(['/files/$'])).toThrow('通配')
    expect(() => pagesRedirects(['/assets/report'])).toThrow('/assets')
  })

  it('ships a top-level 404.html and no catch-all _redirects', async () => {
    // 没有顶层 404.html 时 Pages 进入 SPA 模式，任何缺失路径都会回首页 HTML。
    expect(await readFile(join(adminRoot, 'public/404.html'), 'utf8')).toContain('Page not found')
    await expect(readFile(join(adminRoot, 'public/_redirects'), 'utf8')).rejects.toThrow()
    const headers = await readFile(join(adminRoot, 'public/_headers'), 'utf8')
    expect(headers).toMatch(/^\/assets\/\*\n\s+Cache-Control: public, max-age=31536000, immutable/m)
    expect(headers).not.toMatch(/^\/\*/m)
  })
})

describe('verifyAdminPagesRelease', () => {
  let dist: string
  const html =
    '<!doctype html><title>admin</title><script type="module" crossorigin src="/assets/index-abc123.js"></script>'

  beforeEach(async () => {
    dist = await mkdtemp(join(tmpdir(), 'admin-pages-release-'))
    await mkdir(join(dist, 'assets'))
    await writeFile(join(dist, 'index.html'), html)
    await writeFile(join(dist, '404.html'), 'Page not found')
    await writeFile(join(dist, '_redirects'), pagesRedirects(adminRoutePaths(routeTree)))
    await writeFile(join(dist, 'assets/index-abc123.js'), 'export {}')
    await writeFile(join(dist, 'assets/lazy-def456.js'), 'export default 1')
  })
  afterEach(async () => {
    await rm(dist, { recursive: true, force: true })
  })

  const good = async (url: URL) => {
    if (url.pathname.includes('missing-'))
      return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } })
    if (!url.pathname.startsWith('/assets/'))
      return new Response(html, {
        headers: {
          'content-type': 'text/html',
          'cache-control': 'public, max-age=0, must-revalidate',
        },
      })
    return new Response(await readFile(join(dist, url.pathname)), {
      headers: { 'content-type': 'application/javascript' },
    })
  }

  it('passes against the Pages emulator with the generated rules', async () => {
    const server = await serveDist(dist)
    try {
      await verifyAdminPagesRelease(server.origin, dist)
      const missing = await fetch(`${server.origin}/assets/index-000000.js`)
      expect(missing.status).toBe(404)
    } finally {
      await server.close()
    }
  })

  it('catches the production bug: a missing asset served as HTML cached for a year', async () => {
    await expect(
      verifyAdminPagesRelease('https://example.test', dist, async (url: URL) =>
        url.pathname.includes('missing-')
          ? new Response(html, {
              headers: {
                'content-type': 'text/html',
                'cache-control': 'public, max-age=31536000, immutable',
              },
            })
          : good(url),
      ),
    ).rejects.toThrow('Missing asset must return a non-reusable 404: assets 200')
  })

  it('rejects the old catch-all rule in the build', async () => {
    await writeFile(join(dist, '_redirects'), '/*  /index.html  200\n')
    await expect(verifyAdminPagesRelease('https://example.test', dist, good)).rejects.toThrow(
      'Unexpected Admin redirect rule',
    )
  })

  it('rejects a deep link that does not serve this release', async () => {
    await expect(
      verifyAdminPagesRelease('https://example.test', dist, async (url: URL) =>
        url.pathname === '/users/release-check'
          ? new Response('Page not found', {
              status: 404,
              headers: { 'content-type': 'text/html' },
            })
          : good(url),
      ),
    ).rejects.toThrow('Application deep link did not return HTML: /users/release-check 404')
  })

  it('rejects a homepage cached long-lived or from another release', async () => {
    await expect(
      verifyAdminPagesRelease('https://example.test', dist, async (url: URL) =>
        url.pathname === '/'
          ? new Response(html, {
              headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=3600' },
            })
          : good(url),
      ),
    ).rejects.toThrow('cached long-lived')
    await expect(
      verifyAdminPagesRelease('https://example.test', dist, async (url: URL) =>
        url.pathname === '/'
          ? new Response(html.replace('abc123', 'zzz999'), {
              headers: { 'content-type': 'text/html' },
            })
          : good(url),
      ),
    ).rejects.toThrow('Homepage references another release')
  })

  it('rejects a lazy chunk whose bytes differ from the build', async () => {
    await expect(
      verifyAdminPagesRelease('https://example.test', dist, async (url: URL) =>
        url.pathname.includes('lazy-')
          ? new Response('export default 2', {
              headers: { 'content-type': 'application/javascript' },
            })
          : good(url),
      ),
    ).rejects.toThrow('Asset content differs')
  })

  it('is selected by the retry wrapper for app=admin', async () => {
    await verifyPagesReleaseWithRetry('https://example.test', dist, {
      app: 'admin',
      intervalMs: 1,
      timeoutMs: 1000,
      fetcher: good,
    })
  })
})

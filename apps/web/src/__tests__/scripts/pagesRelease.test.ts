// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { APP_MODE_PATHS, LEGACY_PROJECTS_PATH } from '../../lib/appPaths'
import { PROJECT_ROUTE_PATTERN, pagesRedirects } from '../../lib/pagesRedirects'

const root = resolve(__dirname, '../../../../..')
const { verifyPagesRelease, verifyPagesReleaseWithRetry } = await import(
  pathToFileURL(join(root, 'scripts/verify-pages-release.mjs')).href
)
let dist: string
const html = `<meta name="aip-html-build" content="${'a'.repeat(64)}"><script id="startup-guard">guard()</script><script type="module" src="/assets/main-123.js"></script>`
beforeEach(async () => {
  dist = await mkdtemp(join(tmpdir(), 'pages-release-'))
  await mkdir(join(dist, 'assets'))
  await writeFile(join(dist, 'index.html'), html)
  await writeFile(join(dist, '_redirects'), pagesRedirects())
  await writeFile(join(dist, 'assets/main-123.js'), 'export {}')
  await writeFile(join(dist, 'assets/lazy-456.js'), 'export default 1')
})
afterEach(async () => {
  await rm(dist, { recursive: true, force: true })
})

const good = async (url: URL) => {
  if (!url.pathname.includes('.'))
    return new Response(html, { headers: { 'content-type': 'text/html' } })
  if (url.pathname.includes('missing-'))
    return new Response('Not found', {
      status: 404,
      headers: { 'cache-control': 'public, max-age=0, must-revalidate' },
    })
  return new Response(await readFile(join(dist, url.pathname)), {
    headers: { 'content-type': 'application/javascript' },
  })
}
it('verifies deployed bytes and real missing-resource behavior', async () => {
  await verifyPagesRelease('https://example.test', dist, good)
})
it('rejects the incident: HTML cached under a successful JS URL', async () => {
  await expect(
    verifyPagesRelease('https://example.test', dist, async (url: URL) =>
      url.pathname.endsWith('main-123.js')
        ? new Response(html, { headers: { 'content-type': 'text/html' } })
        : good(url),
    ),
  ).rejects.toThrow('Invalid asset')
})
it('also rejects broken lazy chunks, even when the entry is valid', async () => {
  await expect(
    verifyPagesRelease('https://example.test', dist, async (url: URL) =>
      url.pathname.includes('lazy-')
        ? new Response('export default 2', {
            headers: { 'content-type': 'application/javascript' },
          })
        : good(url),
    ),
  ).rejects.toThrow('Asset content differs')
})
it('rejects successful SPA fallback for missing assets', async () => {
  await expect(
    verifyPagesRelease('https://example.test', dist, async (url: URL) =>
      url.pathname.includes('missing-') ? new Response(html) : good(url),
    ),
  ).rejects.toThrow('Missing asset')
})
it('rejects long-lived error caching', async () => {
  await expect(
    verifyPagesRelease('https://example.test', dist, async (url: URL) =>
      url.pathname.includes('missing-')
        ? new Response('Not found', {
            status: 404,
            headers: { 'cache-control': 'public, max-age=31536000, immutable' },
          })
        : good(url),
    ),
  ).rejects.toThrow('Missing asset')
})
it('generates SPA fallbacks for every app route without a catch-all asset rewrite', async () => {
  const rules = pagesRedirects()
  for (const path of [
    ...Object.values(APP_MODE_PATHS),
    LEGACY_PROJECTS_PATH,
    PROJECT_ROUTE_PATTERN,
  ]) {
    expect(rules).toContain(`${path} / 200\n`)
    expect(rules).toContain(`${path}/ / 200\n`)
  }
  expect(rules).toContain('/assets / 200\n')
  expect(rules).not.toMatch(/^\/assets\/\*/m)
  expect(rules).not.toMatch(/^\/\*/m)
  expect(await readFile(join(root, 'apps/web/public/404.html'), 'utf8')).toContain('Page not found')
})

it('rejects a stale deep link even when the home page is current', async () => {
  await expect(
    verifyPagesRelease('https://example.test', dist, async (url: URL) =>
      url.pathname === '/tools'
        ? new Response(html.replace('a'.repeat(64), 'b'.repeat(64)), {
            headers: { 'content-type': 'text/html' },
          })
        : good(url),
    ),
  ).rejects.toThrow('Application deep link did not serve this release: /tools')
})

it('rejects a broken project deep link even if the home page works', async () => {
  await expect(
    verifyPagesRelease('https://example.test', dist, async (url: URL) =>
      url.pathname.startsWith('/p/') ? new Response('Not found', { status: 404 }) : good(url),
    ),
  ).rejects.toThrow('Application deep link')
})

it('rejects an old HTML build even if its entry script URL is unchanged', async () => {
  await expect(
    verifyPagesRelease('https://example.test', dist, async (url: URL) =>
      url.pathname === '/'
        ? new Response(html.replace('a'.repeat(64), 'b'.repeat(64)), {
            headers: { 'content-type': 'text/html' },
          })
        : good(url),
    ),
  ).rejects.toThrow('Homepage references another release')
})
it('waits for propagation using the same ordinary URLs', async () => {
  let attempts = 0
  await verifyPagesReleaseWithRetry('https://example.test', dist, {
    intervalMs: 1,
    timeoutMs: 1000,
    fetcher: (url: URL) => {
      expect(url.search).toBe('')
      if (url.pathname === '/' && ++attempts === 1)
        return Promise.resolve(new Response('Old version', { status: 503 }))
      return good(url)
    },
  })
  expect(attempts).toBe(2)
})
it('stops retrying a persistently broken release at the deadline', async () => {
  await expect(
    verifyPagesReleaseWithRetry('https://example.test', dist, {
      intervalMs: 2,
      timeoutMs: 15,
      fetcher: () => Promise.resolve(new Response('Old version', { status: 503 })),
    }),
  ).rejects.toThrow()
})

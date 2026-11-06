// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  APP_MODE_PATHS,
  CHANGELOG_PATH,
  CLI_CONNECT_PATH,
  CLI_DEVICE_PATH,
  LEGACY_PROJECTS_PATH,
  PRICING_PATH,
  PRIVACY_PATH,
  TERMS_PATH,
  TOOL_ROUTE_PATTERN,
} from '../../lib/appPaths'
import { PROJECT_ROUTE_PATTERN, pagesRedirects } from '../../lib/pagesRedirects'

const root = resolve(__dirname, '../../../../..')
const { serveDist } = createRequire(import.meta.url)(join(root, 'scripts/pages-browser-smoke.cjs'))
const { verifyPagesRelease, verifyPagesReleaseWithRetry } = await import(
  pathToFileURL(join(root, 'scripts/verify-pages-release.mjs')).href
)
let dist: string
const html = `<meta name="aip-html-build" content="${'a'.repeat(64)}"><script id="startup-guard">guard()</script><script type="module" src="/assets/main-123.js"></script>`
beforeEach(async () => {
  dist = await mkdtemp(join(tmpdir(), 'pages-release-'))
  await mkdir(join(dist, 'assets'))
  await writeFile(join(dist, 'index.html'), html)
  await writeFile(join(dist, 'workbench.html'), html)
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
it('keeps deep links on their incoming URLs under Pages clean-HTML routing', async () => {
  const server = await serveDist(dist)
  try {
    for (const path of ['/image', '/p/example', '/pricing']) {
      const response = await fetch(server.origin + path, { redirect: 'manual' })
      expect(response.status).toBe(200)
      expect(response.headers.get('location')).toBeNull()
      expect(await response.text()).toBe(html)
    }
    await verifyPagesRelease(server.origin, dist)
  } finally {
    await server.close()
  }
})
it('catches the production incident: an html rewrite target redirects the deep link', async () => {
  await writeFile(join(dist, '_redirects'), '/image /workbench.html 200\n')
  const server = await serveDist(dist)
  try {
    const response = await fetch(`${server.origin}/image`, { redirect: 'manual' })
    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('/workbench')
    await expect(verifyPagesRelease(server.origin, dist)).rejects.toThrow('fetch failed')
  } finally {
    await server.close()
  }
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
    TOOL_ROUTE_PATTERN,
    PRICING_PATH,
    TERMS_PATH,
    PRIVACY_PATH,
    CLI_CONNECT_PATH,
    CLI_DEVICE_PATH,
    CHANGELOG_PATH,
  ]) {
    expect(rules).toContain(`${path} /workbench 200\n`)
    if (path !== '/assets') expect(rules).toContain(`${path}/ /workbench 200\n`)
  }
  expect(rules).toContain('/assets /workbench 200\n')
  // `/assets/` 落在 `_headers` 的一年 immutable 规则里：不能在那里下发 HTML。
  expect(rules).toContain('/assets/ /assets 301\n')
  expect(rules).not.toContain('/assets/ /workbench 200')
  expect(rules).not.toMatch(/^\/assets\/\*/m)
  expect(rules).not.toMatch(/^\/\*/m)
  expect(await readFile(join(root, 'apps/web/public/404.html'), 'utf8')).toContain('Page not found')
})
it('整页路由在 BFF 与 nginx 的 SPA 回退里也有：新页面不能只在 Pages 上能刷新', async () => {
  // 三套托管各写一份白名单；漏掉任何一份，那种部署下直接打开或刷新该地址就是 404。
  const bff = await readFile(join(root, 'apps/bff/src/app.ts'), 'utf8')
  const nginx = await readFile(join(root, 'deploy/nginx.conf'), 'utf8')
  for (const path of [
    PRICING_PATH,
    TERMS_PATH,
    PRIVACY_PATH,
    CLI_CONNECT_PATH,
    CLI_DEVICE_PATH,
    CHANGELOG_PATH,
  ]) {
    const name = path.slice(1)
    expect(bff, `BFF 回退缺 ${path}`).toContain(`|${name}`)
    expect(nginx, `nginx 回退缺 ${path}`).toContain(name)
  }
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

it('rejects a deep link whose HTML is cached as long-lived', async () => {
  await expect(
    verifyPagesRelease('https://example.test', dist, async (url: URL) =>
      url.pathname === '/tools'
        ? new Response(html, {
            headers: {
              'content-type': 'text/html',
              'cache-control': 'public, max-age=31536000, immutable',
            },
          })
        : good(url),
    ),
  ).rejects.toThrow('Application deep link is cached long-lived: /tools')
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

it.each(['/', '/guide/'])('rejects long-lived static HTML at %s', async (path) => {
  await mkdir(join(dist, 'guide'))
  await writeFile(join(dist, 'guide/index.html'), html)
  await writeFile(
    join(dist, 'site-pages.json'),
    JSON.stringify([{ path: '/' }, { path: '/guide/' }]),
  )
  await expect(
    verifyPagesRelease('https://example.test', dist, async (url: URL) =>
      url.pathname === path
        ? new Response(html, {
            headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=3600' },
          })
        : good(url),
    ),
  ).rejects.toThrow('cached long-lived')
})
it('rejects a missing website chunk even when workbench missing assets are correct', async () => {
  await expect(
    verifyPagesRelease('https://example.test', dist, async (url: URL) =>
      url.pathname.startsWith('/website-assets/release-check-missing-')
        ? new Response(html)
        : good(url),
    ),
  ).rejects.toThrow('Missing asset')
})

// An edge that accepts a request and never answers it, until the client aborts.
const stall = (init?: RequestInit) =>
  new Promise<Response>((_, reject) =>
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
  )
it('retries one stalled asset request instead of failing the whole pass', async () => {
  let stalls = 0
  await verifyPagesRelease(
    'https://example.test',
    dist,
    (url: URL, init?: RequestInit) =>
      url.pathname.endsWith('lazy-456.js') && ++stalls === 1 ? stall(init) : good(url),
    AbortSignal.timeout(5000),
    { requestTimeoutMs: 20 },
  )
  expect(stalls).toBe(2)
})
it('names the URL that keeps stalling', async () => {
  await expect(
    verifyPagesRelease(
      'https://example.test',
      dist,
      (url: URL, init?: RequestInit) =>
        url.pathname.endsWith('lazy-456.js') ? stall(init) : good(url),
      AbortSignal.timeout(5000),
      { requestTimeoutMs: 20, requestTries: 2 },
    ),
  ).rejects.toThrow('GET /assets/lazy-456.js failed: no response in 20ms after 2 tries')
})

async function releaseCheckout(edition: string, pagesEnvLines: string[], stub = 'exit 27') {
  const checkout = join(dist, 'checkout')
  await mkdir(join(checkout, 'scripts/lib'), { recursive: true })
  await mkdir(join(checkout, 'private/apps/web'), { recursive: true })
  await mkdir(join(checkout, 'bin'))
  for (const script of ['pages-release.sh', 'pages-deploy.sh', 'lib/deploy-common.sh']) {
    await writeFile(
      join(checkout, 'scripts', script),
      await readFile(join(root, 'scripts', script)),
      {
        mode: 0o755,
      },
    )
  }
  // Stands in for the browser smoke that runs right after the dist is finalized.
  await writeFile(join(checkout, 'scripts/pages-browser-smoke.sh'), 'exit 28\n')
  await writeFile(join(checkout, 'private/apps/web/index.tsx'), 'export {}\n')
  const captured = join(checkout, 'build-env')
  // Stop at the real build boundary: never build, upload, or call a live origin in this test.
  await writeFile(
    join(checkout, 'bin/pnpm'),
    `#!/bin/sh
printf '%s\\n' "$*" "$PRIVATE_WEB_OVERLAY_ENTRY" "$BFF_BASE_URL" "$PUBLIC_ORIGIN" "$SEARCH_INDEXING" "$CLOUDFLARE_ACCOUNT_ID" "$CLOUDFLARE_API_TOKEN" "$EXTRA_ASSETS_DIR" "$BFF_BASE_URLS_BY_ORIGIN" "$NOINDEX_ORIGINS" > "$CAPTURED"
${stub}
`,
    { mode: 0o755 },
  )
  const pagesEnv = join(checkout, 'pages.env')
  await writeFile(pagesEnv, pagesEnvLines.join('\n'))
  const run = spawnSync('sh', [join(checkout, 'scripts/pages-release.sh'), edition], {
    cwd: checkout,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(checkout, 'bin')}:${process.env.PATH}`,
      PAGES_ENV_FILE: pagesEnv,
      XDG_CONFIG_HOME: join(checkout, 'config'),
      PAGES_DEPLOY_DRY_RUN: '',
      CAPTURED: captured,
      EXTRA_ASSETS_DIR: '/must-not-inherit-assets',
      BFF_BASE_URLS_BY_ORIGIN: '',
      NOINDEX_ORIGINS: '',
    },
  })
  return { checkout, captured, run }
}

const paidEnv = (checkout: string, extra: string[] = []) => [
  'PAID_PAGES_PROJECT=paid-project',
  'PAID_BFF_BASE_URL=https://api.paid.example.com',
  'PAID_PUBLIC_ORIGIN=https://paid.example.com',
  'PAID_CLOUDFLARE_ACCOUNT_ID=paid-account',
  `PAID_CLOUDFLARE_TOKEN_FILE=${join(checkout, 'token.env')}`,
  `PAID_EXTRA_ASSETS_DIR=${join(checkout, 'paid-assets')}`,
  ...extra,
]

async function prepareSecrets(checkout: string) {
  await mkdir(join(checkout, 'paid-assets'), { recursive: true })
  await writeFile(join(checkout, 'token.env'), 'CLOUDFLARE_API_TOKEN=paid-token\n')
}

it('builds muvloom with the overlay and legacy external Pages config keys', async () => {
  const checkout = join(dist, 'checkout')
  await mkdir(checkout, { recursive: true })
  await prepareSecrets(checkout)
  const { captured, run } = await releaseCheckout('muvloom', paidEnv(checkout))
  expect(run.status).toBe(27)
  expect(run.stderr).toBe('')
  expect(run.stdout).toContain('private web bundle to Pages project paid-project')
  expect(await readFile(captured, 'utf8')).toBe(
    [
      '--filter @image-playground/web build:static-host',
      join(checkout, 'private/apps/web/index.tsx'),
      'https://api.paid.example.com',
      'https://paid.example.com',
      'true',
      'paid-account',
      'paid-token',
      join(checkout, 'paid-assets'),
      '',
      '',
      '',
    ].join('\n'),
  )
})

it('serves the enterprise domain from the muvloom project with its own API and no indexing', async () => {
  const checkout = join(dist, 'checkout')
  await mkdir(checkout, { recursive: true })
  await prepareSecrets(checkout)
  const { captured, run } = await releaseCheckout(
    'muvloom',
    paidEnv(checkout, [
      `PAID_BFF_BASE_URLS_BY_ORIGIN='{"https://old.example.com":"https://old-api.example.com"}'`,
      'ENTERPRISE_PUBLIC_ORIGIN=https://enterprise.example.net/',
      'ENTERPRISE_BFF_BASE_URL=https://enterprise-api.example.net',
    ]),
    `mkdir -p apps/web/dist && printf '/assets/*\\n  Cache-Control: immutable\\n' > apps/web/dist/_headers`,
  )
  // 28 is the stubbed browser smoke: the headers are final before the smoke and the upload.
  expect(run.status).toBe(28)
  expect(run.stdout).toContain('private web bundle to Pages project paid-project')
  const lines = (await readFile(captured, 'utf8')).split('\n')
  expect(lines[3]).toBe('https://paid.example.com')
  expect(lines[4]).toBe('true')
  expect(JSON.parse(lines[8])).toEqual({
    'https://old.example.com': 'https://old-api.example.com',
    'https://enterprise.example.net': 'https://enterprise-api.example.net',
  })
  expect(lines[9]).toBe('https://enterprise.example.net')
  expect(await readFile(join(checkout, 'apps/web/dist/_headers'), 'utf8')).toBe(
    '/assets/*\n  Cache-Control: immutable\n\nhttps://enterprise.example.net/*\n  X-Robots-Tag: noindex, nofollow\n',
  )
})

it('rejects an enterprise mapping that contradicts the muvloom origin map', async () => {
  const checkout = join(dist, 'checkout')
  await mkdir(checkout, { recursive: true })
  await prepareSecrets(checkout)
  const { run } = await releaseCheckout(
    'muvloom',
    paidEnv(checkout, [
      `PAID_BFF_BASE_URLS_BY_ORIGIN='{"https://enterprise.example.net":"https://api.paid.example.com"}'`,
      'ENTERPRISE_PUBLIC_ORIGIN=https://enterprise.example.net',
      'ENTERPRISE_BFF_BASE_URL=https://enterprise-api.example.net',
    ]),
  )
  expect(run.status).toBe(1)
  expect(run.stderr).toContain(
    'maps https://enterprise.example.net to https://api.paid.example.com',
  )
})

it('rejects half an enterprise domain config', async () => {
  const checkout = join(dist, 'checkout')
  await mkdir(checkout, { recursive: true })
  await prepareSecrets(checkout)
  const { run } = await releaseCheckout(
    'muvloom',
    paidEnv(checkout, ['ENTERPRISE_PUBLIC_ORIGIN=https://enterprise.example.net']),
  )
  expect(run.status).toBe(1)
  expect(run.stderr).toContain('must be set together')
})

it('rejects an unknown Pages release target with usage', async () => {
  const checkout = join(dist, 'checkout')
  await mkdir(checkout, { recursive: true })
  const { run } = await releaseCheckout('unknown', [])
  expect(run.status).toBe(2)
  expect(run.stderr).toContain('Usage: scripts/pages-release.sh <muvloom|test|admin>')
})

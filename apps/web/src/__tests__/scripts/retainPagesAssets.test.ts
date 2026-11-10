// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const root = resolve(__dirname, '../../../../..')
const { retainPagesAssets, KEEP_RELEASES } = await import(
  pathToFileURL(join(root, 'scripts/retain-pages-assets.mjs')).href
)

const ORIGIN = 'https://site.test'
const NOW = new Date('2026-11-10T00:00:00.000Z')
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString()

let dist: string
const log = vi.fn()

async function put(file: string, body = 'x') {
  await mkdir(dirname(join(dist, file)), { recursive: true })
  await writeFile(join(dist, file), body)
}
const exists = (file: string) =>
  stat(join(dist, file)).then(
    () => true,
    () => false,
  )
const js = (body: string) =>
  new Response(body, { headers: { 'content-type': 'application/javascript' } })
const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
const notFound = () => new Response('Not found', { status: 404 })

/** Routes by pathname; anything unlisted is a 404. */
function site(routes: Record<string, () => Response | Promise<Response>>) {
  return vi.fn(async (input: URL | string) => {
    const route = routes[new URL(input).pathname]
    return route ? route() : notFound()
  })
}
async function manifest() {
  return JSON.parse(await readFile(join(dist, 'assets-manifest.json'), 'utf8'))
}
const run = (fetchImpl: ReturnType<typeof site>, options: { maxFiles?: number } = {}) =>
  retainPagesAssets({
    distDir: dist,
    origin: ORIGIN,
    fetchImpl,
    now: NOW,
    retryDelayMs: 0,
    log,
    ...options,
  })

beforeEach(async () => {
  dist = await mkdtemp(join(tmpdir(), 'retain-pages-'))
  log.mockClear()
  await put('index.html', '<html>')
  await put('assets/main-AAAAAAAA.js', 'new main')
  await put('assets/shared-SSSSSSSS.js', 'shared')
  await put('website-assets/site-WWWWWWWW.css', 'site')
  await put('website-assets/home/hero.webp', 'not hashed')
})
afterEach(async () => {
  await rm(dist, { recursive: true, force: true })
})

it('starts the manifest with this release when the site has none', async () => {
  const fetchImpl = site({})
  await run(fetchImpl)
  expect(await manifest()).toEqual({
    version: 1,
    releases: [
      {
        publishedAt: NOW.toISOString(),
        files: [
          'assets/main-AAAAAAAA.js',
          'assets/shared-SSSSSSSS.js',
          'website-assets/site-WWWWWWWW.css',
        ],
      },
    ],
  })
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

it('copies the previous release files that this build no longer has', async () => {
  const fetchImpl = site({
    '/assets-manifest.json': () =>
      json({
        version: 1,
        releases: [
          {
            publishedAt: daysAgo(1),
            files: [
              'assets/AuthGate-OLDOLDOL.js',
              'assets/shared-SSSSSSSS.js',
              'assets/gone-GGGGGGGG.js',
            ],
          },
        ],
      }),
    '/assets/AuthGate-OLDOLDOL.js': () => js('old auth gate'),
    '/assets/shared-SSSSSSSS.js': () => js('must not be fetched'),
  })
  const result = await run(fetchImpl)
  expect(await readFile(join(dist, 'assets/AuthGate-OLDOLDOL.js'), 'utf8')).toBe('old auth gate')
  expect(await readFile(join(dist, 'assets/shared-SSSSSSSS.js'), 'utf8')).toBe('shared')
  expect(await exists('assets/gone-GGGGGGGG.js')).toBe(false)
  expect(result.missing).toEqual(['assets/gone-GGGGGGGG.js'])
  const requested = fetchImpl.mock.calls.map(([url]) => new URL(url).pathname)
  expect(requested).not.toContain('/assets/shared-SSSSSSSS.js')
  // 404 is final: one request, no retries.
  expect(requested.filter((path) => path === '/assets/gone-GGGGGGGG.js')).toHaveLength(1)
  const { releases } = await manifest()
  expect(releases).toHaveLength(2)
  // Files that are gone for good drop out, so the next release does not ask again.
  expect(releases[1].files).toEqual(['assets/AuthGate-OLDOLDOL.js', 'assets/shared-SSSSSSSS.js'])
})

it(`keeps at most ${KEEP_RELEASES} releases and nothing older than 14 days`, async () => {
  const releases = Array.from({ length: 8 }, (_, index) => ({
    publishedAt: daysAgo(index + 1),
    files: [`assets/r${index}-RRRRRRR${index}.js`],
  }))
  releases.push({ publishedAt: daysAgo(30), files: ['assets/ancient-ANCIENT0.js'] })
  const routes: Record<string, () => Response> = {
    '/assets-manifest.json': () => json({ version: 1, releases }),
  }
  for (const release of releases) routes[`/${release.files[0]}`] = () => js('old')
  await run(site(routes))
  const kept = (await manifest()).releases
  expect(kept).toHaveLength(KEEP_RELEASES)
  expect(kept.slice(1).map((release: { publishedAt: string }) => release.publishedAt)).toEqual(
    releases.slice(0, KEEP_RELEASES - 1).map((release) => release.publishedAt),
  )
  expect(await exists('assets/r0-RRRRRRR0.js')).toBe(true)
  expect(await exists(`assets/r${KEEP_RELEASES - 1}-RRRRRRR${KEEP_RELEASES - 1}.js`)).toBe(false)
  expect(await exists('assets/ancient-ANCIENT0.js')).toBe(false)
})

it.each([
  ['a 5xx after retries', () => new Response('down', { status: 503 })],
  [
    'HTML instead of JSON',
    () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
  ],
  ['invalid JSON', () => new Response('{', { headers: { 'content-type': 'application/json' } })],
])('publishes the current build only when the manifest is %s', async (_label, response) => {
  await run(site({ '/assets-manifest.json': response }))
  expect((await manifest()).releases).toHaveLength(1)
  expect(log.mock.calls.flat().join('\n')).toContain('WARNING')
})

it('retries a transient failure and skips a file that stays unavailable', async () => {
  let flaky = 0
  const fetchImpl = site({
    '/assets-manifest.json': () =>
      json({
        version: 1,
        releases: [
          {
            publishedAt: daysAgo(1),
            files: ['assets/flaky-FFFFFFFF.js', 'assets/down-DDDDDDDD.js'],
          },
        ],
      }),
    '/assets/flaky-FFFFFFFF.js': () =>
      ++flaky < 2 ? new Response('busy', { status: 503 }) : js('flaky'),
    '/assets/down-DDDDDDDD.js': () => new Response('down', { status: 502 }),
  })
  const result = await run(fetchImpl)
  expect(await readFile(join(dist, 'assets/flaky-FFFFFFFF.js'), 'utf8')).toBe('flaky')
  expect(result.missing).toEqual(['assets/down-DDDDDDDD.js'])
})

it('never writes an HTML fallback or a path outside the asset roots', async () => {
  const fetchImpl = site({
    '/assets-manifest.json': () =>
      json({
        version: 1,
        releases: [
          {
            publishedAt: daysAgo(1),
            files: [
              'assets/html-HHHHHHHH.js',
              '../escape-EEEEEEEE.js',
              'index.html',
              'assets/../x.js',
            ],
          },
        ],
      }),
    '/assets/html-HHHHHHHH.js': () =>
      new Response('<html>', { headers: { 'content-type': 'text/html' } }),
  })
  await run(fetchImpl)
  expect(await exists('assets/html-HHHHHHHH.js')).toBe(false)
  expect(await readFile(join(dist, 'index.html'), 'utf8')).toBe('<html>')
  const requested = fetchImpl.mock.calls.map(([url]) => new URL(url).pathname)
  expect(requested).toEqual(['/assets-manifest.json', '/assets/html-HHHHHHHH.js'])
})

it('skips empty, mistyped or unreadable bodies instead of publishing them', async () => {
  const broken = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error('connection reset'))
      },
    }),
    { headers: { 'content-type': 'application/javascript' } },
  )
  const result = await run(
    site({
      '/assets-manifest.json': () =>
        json({
          version: 1,
          releases: [
            {
              publishedAt: daysAgo(1),
              files: [
                'assets/empty-EEEEEEEE.js',
                'assets/plain-PPPPPPPP.css',
                'assets/reset-RRRRRRRR.js',
                'assets/ok-OOOOOOOO.css',
              ],
            },
          ],
        }),
      '/assets/empty-EEEEEEEE.js': () => js(''),
      '/assets/plain-PPPPPPPP.css': () =>
        new Response('body{}', { headers: { 'content-type': 'text/plain' } }),
      '/assets/reset-RRRRRRRR.js': () => broken,
      '/assets/ok-OOOOOOOO.css': () =>
        new Response('body{}', { headers: { 'content-type': 'text/css; charset=utf-8' } }),
    }),
  )
  expect(result.missing).toEqual([
    'assets/empty-EEEEEEEE.js',
    'assets/plain-PPPPPPPP.css',
    'assets/reset-RRRRRRRR.js',
  ])
  expect(await exists('assets/ok-OOOOOOOO.css')).toBe(true)
  expect(await exists('assets/empty-EEEEEEEE.js')).toBe(false)
})

it('drops the oldest releases instead of failing when the file limit is near', async () => {
  // The site already has 5 files plus the manifest; room for exactly one retained file.
  const fetchImpl = site({
    '/assets-manifest.json': () =>
      json({
        version: 1,
        releases: [
          { publishedAt: daysAgo(1), files: ['assets/newer-NNNNNNNN.js'] },
          { publishedAt: daysAgo(2), files: ['assets/older-OOOOOOOO.js'] },
        ],
      }),
    '/assets/newer-NNNNNNNN.js': () => js('newer'),
    '/assets/older-OOOOOOOO.js': () => js('older'),
  })
  await run(fetchImpl, { maxFiles: 7 })
  expect(await exists('assets/newer-NNNNNNNN.js')).toBe(true)
  expect(await exists('assets/older-OOOOOOOO.js')).toBe(false)
  expect((await manifest()).releases).toHaveLength(2)
  expect(log.mock.calls.flat().join('\n')).toContain('dropping the release')
})

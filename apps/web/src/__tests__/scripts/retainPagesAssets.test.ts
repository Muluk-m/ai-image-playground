// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../../../../..')
const { serveDist } = createRequire(import.meta.url)(join(root, 'scripts/pages-browser-smoke.cjs'))
const {
  DEFAULT_LIMITS,
  MAX_ASSET_BYTES,
  assetReferencesFrom,
  planAssetRetention,
  readBounded,
  retainPagesAssets,
  safeAssetPath,
} = await import(pathToFileURL(join(root, 'scripts/retain-pages-assets.mjs')).href)

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-11-10T00:00:00.000Z')

function release(id: string, ageDays: number, files: Array<[string, number]>) {
  return {
    id,
    publishedAt: new Date(NOW.getTime() - ageDays * DAY).toISOString(),
    files: files.map(([path, bytes]) => ({ path, bytes })),
  }
}

function plan(
  previous: ReturnType<typeof release>[],
  currentFiles: Array<[string, number]> = [['assets/new-a.js', 10]],
  limits = DEFAULT_LIMITS,
  occupiedFiles = 10,
) {
  return planAssetRetention({
    now: NOW,
    current: {
      id: 'current',
      publishedAt: NOW.toISOString(),
      files: currentFiles.map(([path, bytes]) => ({ path, bytes })),
    },
    previousReleases: previous,
    occupiedFiles,
    limits,
  })
}

describe('assetReferencesFrom', () => {
  it('reads Vite __vite__mapDeps bare asset strings', () => {
    const source = `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/CanvasMode-CkYmZLXv.css","assets/CanvasMode-8Ru5DQEN.js"])))=>i.map(i=>d[i])`
    expect(assetReferencesFrom(source).sort()).toEqual([
      'assets/CanvasMode-8Ru5DQEN.js',
      'assets/CanvasMode-CkYmZLXv.css',
    ])
  })
})

describe('planAssetRetention', () => {
  it('keeps the latest five releases and anything newer than 14 days', () => {
    const previous = [
      release('d1', 1, [['assets/a.js', 5]]),
      release('d2', 2, [['assets/b.js', 5]]),
      release('d4', 4, [['assets/c.js', 5]]),
      release('d6', 6, [['assets/d.js', 5]]),
      release('d8', 8, [['assets/e.js', 5]]),
      release('d10', 10, [['assets/f.js', 5]]),
      release('d20', 20, [['assets/g.js', 5]]),
      release('d40', 40, [['assets/h.js', 5]]),
    ]
    const result = plan(previous)
    const ids = result.releases.map((item: { id: string }) => item.id)
    expect(ids).toEqual(['current', 'd1', 'd2', 'd4', 'd6', 'd8', 'd10'])
    expect(result.copy.map((file: { path: string }) => file.path)).toEqual([
      'assets/a.js',
      'assets/b.js',
      'assets/c.js',
      'assets/d.js',
      'assets/e.js',
      'assets/f.js',
    ])
    expect(result.droppedReleaseIds).toEqual([])
    expect(ids).not.toEqual(expect.arrayContaining(['d20', 'd40']))
  })

  it('drops the oldest selected release when the byte or file cap would be exceeded', () => {
    const limits = { ...DEFAULT_LIMITS, maxRetainedBytes: 12, maxDeployFiles: 100 }
    const result = plan(
      [
        release('newest', 1, [['assets/big.js', 10]]),
        release('older', 2, [['assets/also.js', 10]]),
      ],
      [['assets/current.js', 4]],
      limits,
    )
    expect(result.copy.map((file: { path: string }) => file.path)).toEqual(['assets/big.js'])
    expect(result.droppedReleaseIds).toEqual(['older'])
    expect(result.releases[0].files).toEqual([{ path: 'assets/current.js', bytes: 4 }])
  })

  it('does not copy files the current build already has, or unsafe and oversized ones', () => {
    expect(safeAssetPath('../assets/x.js')).toBe(false)
    expect(safeAssetPath('assets/../secret.js')).toBe(false)
    expect(safeAssetPath('index.html')).toBe(false)
    const result = plan(
      [
        release('old', 1, [
          ['assets/new-a.js', 10],
          ['assets/keep.js', 8],
          ['assets/../x.js', 8],
          ['assets/huge.js', MAX_ASSET_BYTES],
          ['version.json', 4],
        ]),
      ],
      [
        ['assets/new-a.js', 10],
        ['assets/huge-current.js', MAX_ASSET_BYTES],
      ],
    )
    expect(result.copy).toEqual([{ path: 'assets/keep.js', bytes: 8, releaseId: 'old' }])
    expect(result.releases[0].files).toEqual([{ path: 'assets/new-a.js', bytes: 10 }])
  })

  it('keeps an older script ahead of a newer oversized website file', () => {
    const limits = { ...DEFAULT_LIMITS, maxRetainedBytes: 12 }
    const result = plan(
      [
        release('new', 1, [['website-assets/hero.wasm', 15]]),
        release('old', 2, [['assets/app.js', 8]]),
      ],
      [['assets/current.js', 1]],
      limits,
    )
    expect(result.copy.map((file: { path: string }) => file.path)).toEqual(['assets/app.js'])
    expect(result.droppedReleaseIds).toEqual(['new'])
  })

  it('stops before the deployment file cap, counting files already in dist', () => {
    const limits = { ...DEFAULT_LIMITS, maxDeployFiles: 12 }
    const result = plan(
      [
        release('old', 1, [
          ['assets/one.js', 1],
          ['assets/two.js', 1],
        ]),
      ],
      [['assets/current.js', 1]],
      limits,
      11,
    )
    expect(result.copy).toEqual([{ path: 'assets/one.js', bytes: 1, releaseId: 'old' }])
    expect(result.droppedReleaseIds).toEqual([])
  })
})

describe('retainPagesAssets', () => {
  let dist: string
  const bodies = new Map<string, { status: number; body: string; type: string }>()

  afterEach(async () => {
    bodies.clear()
    if (dist) await rm(dist, { recursive: true, force: true })
  })

  async function setup() {
    dist = await mkdtemp(join(tmpdir(), 'retain-assets-'))
    await mkdir(join(dist, 'assets'))
    await writeFile(join(dist, 'assets/AuthGate-NEW.js'), 'export const next = 1')
    await writeFile(
      join(dist, 'version.json'),
      JSON.stringify({ version: 'abc-20261110', notify: false }),
    )
    await writeFile(join(dist, 'index.html'), '<html>new</html>')
    await writeFile(join(dist, '_redirects'), '# missing assets stay 404\n')
  }

  function fetcher(url: URL) {
    const path = url.pathname
    const found = bodies.get(path)
    if (!found)
      return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } })
    return new Response(found.body, {
      status: found.status,
      headers: { 'content-type': found.type },
    })
  }

  it('downloads previous hashed assets and writes a merged manifest', async () => {
    await setup()
    bodies.set('/assets-manifest.json', {
      status: 200,
      type: 'application/json',
      body: JSON.stringify({
        version: 1,
        releases: [
          {
            id: 'live',
            publishedAt: '2026-11-09T00:00:00.000Z',
            files: [
              { path: 'assets/AuthGate-C6rHP2S1.js', bytes: 12 },
              { path: 'assets/AuthGate-NEW.js', bytes: 22 },
            ],
          },
        ],
      }),
    })
    bodies.set('/assets/AuthGate-C6rHP2S1.js', {
      status: 200,
      type: 'text/javascript',
      body: 'export const old = 1',
    })
    const logs: string[] = []
    bodies.set('/website-assets/SiteAuth-old.js', {
      status: 200,
      type: 'text/javascript',
      body: 'export const site = 1',
    })
    const previousManifest = bodies.get('/assets-manifest.json')
    if (!previousManifest) throw new Error('missing manifest fixture')
    const manifestBody = JSON.parse(previousManifest.body)
    manifestBody.releases[0].files.push({ path: 'website-assets/SiteAuth-old.js', bytes: 20 })
    bodies.set('/assets-manifest.json', {
      status: 200,
      type: 'application/json',
      body: JSON.stringify(manifestBody),
    })
    const result = await retainPagesAssets({
      distDir: dist,
      origin: 'https://muvloom.online',
      fetchImpl: fetcher,
      now: NOW,
      log: (message: string) => logs.push(message),
      retryDelayMs: 0,
    })
    expect(await readFile(join(dist, 'assets/AuthGate-C6rHP2S1.js'), 'utf8')).toBe(
      'export const old = 1',
    )
    expect(await readFile(join(dist, 'assets/AuthGate-NEW.js'), 'utf8')).toBe(
      'export const next = 1',
    )
    const manifest = JSON.parse(await readFile(join(dist, 'assets-manifest.json'), 'utf8'))
    expect(manifest.releases.map((item: { id: string }) => item.id)).toEqual([
      'abc-20261110',
      'live',
    ])
    expect(manifest.releases[1].files).toEqual([
      { path: 'assets/AuthGate-C6rHP2S1.js', bytes: 'export const old = 1'.length },
      { path: 'website-assets/SiteAuth-old.js', bytes: 'export const site = 1'.length },
    ])
    expect(result.copied).toHaveLength(2)
    expect(logs[0]).toMatch(/Retained 2 asset/)

    const server = await serveDist(dist)
    try {
      const site = await fetch(`${server.origin}/website-assets/SiteAuth-old.js`)
      expect(site.status).toBe(200)
      expect(await site.text()).toBe('export const site = 1')
      const old = await fetch(`${server.origin}/assets/AuthGate-C6rHP2S1.js`)
      expect(old.status).toBe(200)
      expect(old.headers.get('content-type')).toMatch(/javascript/)
      expect(await old.text()).toBe('export const old = 1')
      const missing = await fetch(`${server.origin}/assets/AuthGate-MISSING.js`)
      expect(missing.status).toBe(404)
      expect(missing.headers.get('content-type') ?? '').not.toMatch(/javascript/)
    } finally {
      await server.close()
    }
  })

  it('treats a missing manifest as the first release and refuses HTML or a failed manifest', async () => {
    await setup()
    await retainPagesAssets({
      distDir: dist,
      origin: 'https://muvloom.online',
      fetchImpl: fetcher,
      now: NOW,
      log: () => {},
      retryDelayMs: 0,
    })
    const manifest = JSON.parse(await readFile(join(dist, 'assets-manifest.json'), 'utf8'))
    expect(manifest.releases).toHaveLength(1)
    expect(manifest.releases[0].files[0].path).toBe('assets/AuthGate-NEW.js')

    bodies.set('/assets-manifest.json', {
      status: 200,
      type: 'text/html',
      body: '<!doctype html><html></html>',
    })
    await expect(
      retainPagesAssets({
        distDir: dist,
        origin: 'https://muvloom.online',
        fetchImpl: fetcher,
        now: NOW,
        log: () => {},
        retryDelayMs: 0,
      }),
    ).rejects.toThrow('HTML')

    bodies.set('/assets-manifest.json', { status: 500, type: 'text/plain', body: 'nope' })
    await expect(
      retainPagesAssets({
        distDir: dist,
        origin: 'https://muvloom.online',
        fetchImpl: fetcher,
        now: NOW,
        log: () => {},
        retryDelayMs: 0,
      }),
    ).rejects.toThrow('500')
  })

  it('skips a previous asset that 404s or is really index.html, and still publishes', async () => {
    await setup()
    bodies.set('/assets-manifest.json', {
      status: 200,
      type: 'application/json',
      body: JSON.stringify({
        version: 1,
        releases: [
          {
            id: 'live',
            publishedAt: '2026-11-09T00:00:00.000Z',
            files: [
              { path: 'assets/gone.js', bytes: 4 },
              { path: 'assets/spoofed.js', bytes: 20 },
              { path: 'assets/kept.js', bytes: 4 },
            ],
          },
        ],
      }),
    })
    bodies.set('/assets/spoofed.js', {
      status: 200,
      type: 'text/html',
      body: '<!doctype html><html>home</html>',
    })
    bodies.set('/assets/kept.js', { status: 200, type: 'application/javascript', body: 'ok' })
    const result = await retainPagesAssets({
      distDir: dist,
      origin: 'https://muvloom.online',
      fetchImpl: fetcher,
      now: NOW,
      log: () => {},
      retryDelayMs: 0,
    })
    expect(result.skipped.sort()).toEqual(['assets/gone.js', 'assets/spoofed.js'])
    expect(await readFile(join(dist, 'assets/kept.js'), 'utf8')).toBe('ok')
    await expect(readFile(join(dist, 'assets/spoofed.js'))).rejects.toThrow()
    const manifest = JSON.parse(await readFile(join(dist, 'assets-manifest.json'), 'utf8'))
    expect(manifest.releases[1].files.map((file: { path: string }) => file.path)).toEqual([
      'assets/kept.js',
    ])
  })

  it('refuses to publish when most retained assets are missing', async () => {
    await setup()
    const files = ['a', 'b', 'c', 'd'].map((name) => ({
      path: `assets/${name}.js`,
      bytes: 4,
    }))
    bodies.set('/assets-manifest.json', {
      status: 200,
      type: 'application/json',
      body: JSON.stringify({
        version: 1,
        releases: [{ id: 'live', publishedAt: '2026-11-09T00:00:00.000Z', files }],
      }),
    })
    await expect(
      retainPagesAssets({
        distDir: dist,
        origin: 'https://muvloom.online',
        fetchImpl: fetcher,
        now: NOW,
        log: () => {},
        retryDelayMs: 0,
      }),
    ).rejects.toThrow('Refusing to publish')
  })

  it('bootstraps the live graph when the manifest is missing but the app is being served', async () => {
    await setup()
    bodies.set('/', {
      status: 200,
      type: 'text/html',
      body: '<!doctype html><script type="module" src="/assets/main-abc.js"></script>',
    })
    bodies.set('/assets/main-abc.js', {
      status: 200,
      type: 'text/javascript',
      body: 'import"./AuthGate-old.js";const site="/website-assets/Site-xyz.js";const evil="https://cdn.example/assets/evil.js";const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/CanvasMode-CkYmZLXv.css"])))=>i.map(i=>d[i])',
    })
    bodies.set('/assets/CanvasMode-CkYmZLXv.css', {
      status: 200,
      type: 'text/css',
      body: '.canvas{}',
    })
    bodies.set('/assets/AuthGate-old.js', {
      status: 200,
      type: 'text/javascript',
      body: 'export const old = 1',
    })
    bodies.set('/website-assets/Site-xyz.js', {
      status: 200,
      type: 'text/javascript',
      body: 'export const site = 1',
    })
    const result = await retainPagesAssets({
      distDir: dist,
      origin: 'https://muvloom.online',
      fetchImpl: fetcher,
      now: NOW,
      log: () => {},
      retryDelayMs: 0,
    })
    expect(await readFile(join(dist, 'assets/AuthGate-old.js'), 'utf8')).toBe(
      'export const old = 1',
    )
    expect(await readFile(join(dist, 'website-assets/Site-xyz.js'), 'utf8')).toBe(
      'export const site = 1',
    )
    expect(await readFile(join(dist, 'assets/CanvasMode-CkYmZLXv.css'), 'utf8')).toBe('.canvas{}')
    expect(result.copied.map((file: { path: string }) => file.path).sort()).toEqual([
      'assets/AuthGate-old.js',
      'assets/CanvasMode-CkYmZLXv.css',
      'assets/main-abc.js',
      'website-assets/Site-xyz.js',
    ])
  })

  it('merges a hash that shows up in the live manifest before upload', async () => {
    await setup()
    bodies.set('/assets/first.js', { status: 200, type: 'text/javascript', body: 'one' })
    bodies.set('/assets/second.js', { status: 200, type: 'text/javascript', body: 'two!' })
    let reads = 0
    const result = await retainPagesAssets({
      distDir: dist,
      origin: 'https://muvloom.online',
      now: NOW,
      log: () => {},
      retryDelayMs: 0,
      fetchImpl: (url: URL) => {
        if (url.pathname === '/assets-manifest.json') {
          reads += 1
          const files =
            reads === 1
              ? [{ path: 'assets/first.js', bytes: 3 }]
              : [
                  { path: 'assets/first.js', bytes: 3 },
                  { path: 'assets/second.js', bytes: 4 },
                ]
          return new Response(
            JSON.stringify({
              version: 1,
              releases: [{ id: 'live', publishedAt: '2026-11-09T00:00:00.000Z', files }],
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        }
        return fetcher(url)
      },
    })
    expect(reads).toBeGreaterThan(1)
    expect(await readFile(join(dist, 'assets/second.js'), 'utf8')).toBe('two!')
    expect(result.copied.map((file: { path: string }) => file.path).sort()).toEqual([
      'assets/first.js',
      'assets/second.js',
    ])
  })

  it('retries a transient 503 and does not keep a body past the file cap', async () => {
    await setup()
    let tries = 0
    let pulled = 0
    bodies.set('/assets-manifest.json', {
      status: 200,
      type: 'application/json',
      body: JSON.stringify({
        version: 1,
        releases: [
          {
            id: 'live',
            publishedAt: '2026-11-09T00:00:00.000Z',
            files: [
              { path: 'assets/flaky.js', bytes: 2 },
              { path: 'assets/huge.js', bytes: 10 },
            ],
          },
        ],
      }),
    })
    const result = await retainPagesAssets({
      distDir: dist,
      origin: 'https://muvloom.online',
      now: NOW,
      log: () => {},
      retryDelayMs: 0,
      fetchImpl: (url: URL) => {
        if (url.pathname === '/assets/flaky.js') {
          tries += 1
          if (tries < 3) return new Response('no', { status: 503 })
          return new Response('ok', { headers: { 'content-type': 'text/javascript' } })
        }
        if (url.pathname === '/assets/huge.js') {
          const stream = new ReadableStream({
            pull(controller) {
              pulled += 1
              if (pulled > 40) {
                controller.close()
                return
              }
              controller.enqueue(new Uint8Array(1024 * 1024))
            },
          })
          return new Response(stream, { headers: { 'content-type': 'application/javascript' } })
        }
        return fetcher(url)
      },
    })
    expect(tries).toBe(3)
    expect(await readFile(join(dist, 'assets/flaky.js'), 'utf8')).toBe('ok')
    await expect(readFile(join(dist, 'assets/huge.js'))).rejects.toThrow()
    expect(pulled).toBeLessThan(40)
    expect(result.skipped).toContain('assets/huge.js')
  })

  it('warns about a current file at the Pages size cap and leaves it out of the manifest', async () => {
    await setup()
    await writeFile(join(dist, 'assets/too-big.js'), Buffer.alloc(MAX_ASSET_BYTES))
    const logs: string[] = []
    await retainPagesAssets({
      distDir: dist,
      origin: 'https://muvloom.online',
      fetchImpl: fetcher,
      now: NOW,
      log: (message: string) => logs.push(message),
      retryDelayMs: 0,
    })
    expect(logs.join('\n')).toContain('assets/too-big.js')
    const manifest = JSON.parse(await readFile(join(dist, 'assets-manifest.json'), 'utf8'))
    expect(
      manifest.releases[0].files.some(
        (file: { path: string }) => file.path === 'assets/too-big.js',
      ),
    ).toBe(false)
  })

  it('aborts when an entry stays 5xx instead of publishing the current build only', async () => {
    await setup()
    await expect(
      retainPagesAssets({
        distDir: dist,
        origin: 'https://muvloom.online',
        now: NOW,
        log: () => {},
        retryDelayMs: 0,
        fetchImpl: (url: URL) =>
          url.pathname === '/assets-manifest.json'
            ? new Response('missing', { status: 404 })
            : new Response('down', { status: 503 }),
      }),
    ).rejects.toThrow('503')
    await expect(readFile(join(dist, 'assets-manifest.json'))).rejects.toThrow()
  })

  it('does not copy a late hash that would exceed the shared byte budget', async () => {
    await setup()
    let reads = 0
    const result = await retainPagesAssets({
      distDir: dist,
      origin: 'https://muvloom.online',
      now: NOW,
      log: () => {},
      retryDelayMs: 0,
      limits: { ...DEFAULT_LIMITS, maxRetainedBytes: 10 },
      fetchImpl: (url: URL) => {
        if (url.pathname === '/assets-manifest.json') {
          reads += 1
          const files =
            reads === 1
              ? [{ path: 'assets/first.js', bytes: 8 }]
              : [
                  { path: 'assets/first.js', bytes: 8 },
                  { path: 'assets/second.js', bytes: 8 },
                ]
          return new Response(
            JSON.stringify({
              version: 1,
              releases: [{ id: 'live', publishedAt: '2026-11-09T00:00:00.000Z', files }],
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        }
        if (url.pathname === '/assets/first.js') {
          return new Response('12345678', { headers: { 'content-type': 'text/javascript' } })
        }
        if (url.pathname === '/assets/second.js') {
          return new Response('abcdefgh', { headers: { 'content-type': 'text/javascript' } })
        }
        return fetcher(url)
      },
    })
    expect(result.copied.map((file: { path: string }) => file.path)).toEqual(['assets/first.js'])
    await expect(readFile(join(dist, 'assets/second.js'))).rejects.toThrow()
  })

  it('stops before reading a body whose Content-Length is already over the cap', async () => {
    const response = new Response('x', {
      headers: { 'content-length': String(MAX_ASSET_BYTES) },
    })
    const read = await readBounded(response, MAX_ASSET_BYTES)
    expect(read.overflow).toBe(true)
    expect(read.bytes).toBeNull()
  })
})

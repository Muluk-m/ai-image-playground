// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../../../../..')
const { serveDist } = createRequire(import.meta.url)(join(root, 'scripts/pages-browser-smoke.cjs'))
const { DEFAULT_LIMITS, MAX_ASSET_BYTES, planAssetRetention, retainPagesAssets, safeAssetPath } =
  await import(pathToFileURL(join(root, 'scripts/retain-pages-assets.mjs')).href)

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
    expect(result.copy).toEqual([])
    expect(result.droppedReleaseIds).toEqual(['old'])
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
})

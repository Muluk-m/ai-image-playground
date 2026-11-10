#!/usr/bin/env node
// Pages serves only the latest deployment on a custom domain, so a tab opened on the previous
// release gets 404 for chunks it has not loaded yet. Before upload, copy the hashed files of the
// last few releases from the live site into this dist and record them in assets-manifest.json.
//
// Usage: node scripts/retain-pages-assets.mjs <dist-dir> <live-origin>
//
// Never blocks a release: if the live site or a file cannot be read, it warns and publishes
// what it has. Tabs that still miss a chunk reload once (startup guard in
// apps/web/src/boot/vitePlugin.ts, and apps/web/src/lib/chunkLoad.ts for the workbench).
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const MANIFEST = 'assets-manifest.json'
export const KEEP_RELEASES = 5
export const KEEP_DAYS = 14
/** Pages allows 20,000 files per deployment; older releases are dropped above this. */
export const MAX_FILES = 15_000
/** Pages rejects larger files, so a bigger response is not a real asset. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024
const ROOTS = ['assets', 'website-assets']
/** Vite's default `[name]-[hash].[ext]`: 8 url-safe base64 characters. */
const HASHED = /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/
const SAFE_PATH = /^(?:assets|website-assets)(?:\/[A-Za-z0-9._~-]+)+$/
const ATTEMPTS = 3
const TIMEOUT_MS = 15_000
const CONCURRENCY = 8

async function walk(dir, base) {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const files = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(path, base)))
    else if (entry.isFile()) files.push(relative(base, path).split(sep).join('/'))
  }
  return files
}

export async function listAllFiles(distDir) {
  return walk(distDir, distDir)
}

export async function listHashedFiles(distDir) {
  const files = []
  for (const root of ROOTS) {
    for (const file of await walk(join(distDir, root), distDir)) {
      if (HASHED.test(file)) files.push(file)
    }
  }
  return files.sort()
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 404 returns at once; 5xx, 408, 429 and network errors retry. */
async function get(fetchImpl, url, delayMs) {
  let lastError
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(delayMs * attempt)
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (response.status >= 500 || response.status === 408 || response.status === 429) {
        lastError = new Error(`HTTP ${response.status}`)
        continue
      }
      return response
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

const declaredBytes = (response) => Number(response.headers.get('content-length') ?? 0)

/** Reads at most `limit` bytes; returns null once the body goes past it. */
async function readCapped(response, limit) {
  if (declaredBytes(response) > limit) {
    await response.body?.cancel()
    return null
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.length
    if (size > limit) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

const contentType = (response) => (response.headers.get('content-type') ?? '').toLowerCase()
const isHtml = (response) => contentType(response).includes('text/html')
/** A 200 with the wrong type would be published under an immutable hashed name. */
function typeMatches(file, response) {
  const type = contentType(response)
  if (file.endsWith('.js')) return type.includes('javascript')
  if (file.endsWith('.css')) return type.includes('text/css')
  return !isHtml(response)
}

/** Returns the previous releases, `[]` when the site has no manifest, or `null` when unreadable. */
async function readLiveManifest(origin, fetchImpl, delayMs, log) {
  const url = new URL(MANIFEST, origin)
  url.searchParams.set('retain-check', String(Date.now()))
  let response
  try {
    response = await get(fetchImpl, url, delayMs)
  } catch (error) {
    log(`WARNING: GET ${url.pathname} failed (${error.message}); publishing the current build only.`)
    return null
  }
  if (response.status === 404) {
    log(`No ${MANIFEST} at ${origin}; starting retention with this release.`)
    return []
  }
  if (!response.ok || isHtml(response)) {
    log(`WARNING: GET ${url.pathname} returned ${response.status}; publishing the current build only.`)
    return null
  }
  try {
    const body = await readCapped(response, MAX_MANIFEST_BYTES)
    if (!body) throw new Error(`larger than ${MAX_MANIFEST_BYTES} bytes`)
    const data = JSON.parse(body.toString('utf8'))
    if (!Array.isArray(data?.releases)) throw new Error('no releases array')
    return data.releases.filter(
      (release) =>
        typeof release?.publishedAt === 'string' &&
        Number.isFinite(Date.parse(release.publishedAt)) &&
        Array.isArray(release.files),
    )
  } catch (error) {
    log(`WARNING: ${MANIFEST} is invalid (${error.message}); publishing the current build only.`)
    return null
  }
}

function wantedFiles(kept, present) {
  const wanted = new Set()
  for (const release of kept) {
    for (const file of release.files) {
      if (typeof file === 'string' && SAFE_PATH.test(file) && !file.includes('..') && !present.has(file)) {
        wanted.add(file)
      }
    }
  }
  return wanted
}

export function selectReleases(releases, now) {
  const cutoff = now.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000
  return releases
    .filter((release) => Date.parse(release.publishedAt) >= cutoff)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, KEEP_RELEASES - 1)
}

async function mapPool(items, limit, fn) {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++])
  })
  await Promise.all(workers)
}

export async function retainPagesAssets({
  distDir,
  origin,
  fetchImpl = fetch,
  now = new Date(),
  retryDelayMs = 1000,
  maxFiles = MAX_FILES,
  log = console.log,
}) {
  const current = await listHashedFiles(distDir)
  const previous = (await readLiveManifest(origin, fetchImpl, retryDelayMs, log)) ?? []
  const kept = selectReleases(previous, now)
  const present = new Set(current)
  // Stay under the Pages file limit by dropping the oldest releases, never by failing the release.
  // +1 for the manifest written below.
  const siteFiles = (await listAllFiles(distDir)).length + 1
  let wanted = wantedFiles(kept, present)
  while (kept.length && siteFiles + wanted.size > maxFiles) {
    const dropped = kept.pop()
    log(`WARNING: dropping the release from ${dropped.publishedAt} to stay under ${maxFiles} files.`)
    wanted = wantedFiles(kept, present)
  }

  const missing = new Set()
  let copied = 0
  let bytes = 0
  await mapPool([...wanted], CONCURRENCY, async (file) => {
    if (bytes >= MAX_TOTAL_BYTES) {
      missing.add(file)
      return
    }
    let response
    try {
      response = await get(fetchImpl, new URL(`/${file}`, origin), retryDelayMs)
    } catch (error) {
      log(`WARNING: GET /${file} failed (${error.message}); skipped.`)
      missing.add(file)
      return
    }
    if (!response.ok || !typeMatches(file, response)) {
      if (response.status !== 404) {
        log(`WARNING: GET /${file} returned ${response.status} ${contentType(response)}; skipped.`)
      }
      missing.add(file)
      return
    }
    let body
    try {
      body = await readCapped(response, MAX_FILE_BYTES)
    } catch (error) {
      log(`WARNING: reading /${file} failed (${error.message}); skipped.`)
      missing.add(file)
      return
    }
    if (!body?.length) {
      log(`WARNING: /${file} is ${body ? 'empty' : `over ${MAX_FILE_BYTES} bytes`}; skipped.`)
      missing.add(file)
      return
    }
    const target = join(distDir, file)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, body)
    copied++
    bytes += body.length
  })

  const releases = [
    { publishedAt: now.toISOString(), files: current },
    ...kept.map((release) => ({
      publishedAt: release.publishedAt,
      files: release.files.filter((file) => present.has(file) || (wanted.has(file) && !missing.has(file))),
    })),
  ]
  await writeFile(
    join(distDir, MANIFEST),
    `${JSON.stringify({ version: 1, releases }, null, 2)}\n`,
  )
  if (bytes >= MAX_TOTAL_BYTES) {
    log(`WARNING: stopped downloading at ${MAX_TOTAL_BYTES} bytes; the rest is skipped.`)
  }
  log(
    `Retained ${kept.length} previous release(s): copied ${copied} file(s), ${(bytes / 1024 / 1024).toFixed(1)} MiB; ${missing.size} unavailable.`,
  )
  return { copied, bytes, missing: [...missing].sort(), releases }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [distDir, origin] = process.argv.slice(2)
  if (!distDir || !origin) {
    console.error('Usage: node scripts/retain-pages-assets.mjs <dist-dir> <live-origin>')
    process.exit(1)
  }
  await retainPagesAssets({ distDir, origin })
}

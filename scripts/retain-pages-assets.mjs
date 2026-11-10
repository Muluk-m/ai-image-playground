#!/usr/bin/env node
// 发布前把仍在线上的 /assets 哈希文件并进这次 dist。
//
// Cloudflare Pages 每次上传都是整站替换。Vite 的文件名带内容哈希，旧标签页还指着
// 上一版的 AuthGate-*.js，新部署一上线这些 URL 就没了，动态 import 失败，
// 启动守卫亮出「工作台暂时无法打开」。根因是旧哈希不再存在，不是用户没刷新。
//
// 旧文件从「当前线上站点 + assets-manifest.json」下载，不另建 R2 或 Actions 缓存：
// - 线上部署就是打开的标签页还能请求到的那一份，合并进下一次上传后，下一次发布又能接着拉。
// - 内容哈希不会把两个版本写进同一个文件名。
// - CI 和应急的 pages-release.sh 都已经知道公开 origin，不需要新的密钥或桶。
// - Actions 缓存盖不住应急发布，过期还会把链条剪断。
//
// 清单 404 且页面已经在提供带哈希的脚本：从 HTML 顺着引用（含 Vite 的
// __vite__mapDeps 裸字符串 "assets/…"）把当前正在服务的 /assets 与 /website-assets
// 爬下来保留。入口持续 5xx 或超时则中止发布，不拿「只有本次构建」盖掉线上哈希。
// 四个入口都是明确 404 才算第一次上线。PAGES_SKIP_ASSET_RETAIN=1 可在原点读不了时跳过。
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const RETAIN_RELEASES = 5
export const RETAIN_AGE_MS = 14 * 24 * 60 * 60 * 1000
/** Pages 单文件上限 25 MiB。等于上限的不保留，免得下一次复制时被拒。 */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024
/** Pages 单次部署 20_000 个文件。给页面、图片和本次构建留出余量。 */
export const MAX_DEPLOY_FILES = 16_000
/** 额外下载的旧字节上限，控制发布时间和部署体积。 */
export const MAX_RETAINED_BYTES = 120 * 1024 * 1024

export const DEFAULT_LIMITS = {
  keepReleases: RETAIN_RELEASES,
  keepAgeMs: RETAIN_AGE_MS,
  maxFileBytes: MAX_ASSET_BYTES,
  maxDeployFiles: MAX_DEPLOY_FILES,
  maxRetainedBytes: MAX_RETAINED_BYTES,
}

const ASSET_ROOTS = ['assets', 'website-assets']
const ASSET_PATH = /^(?:assets|website-assets)\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/

export function safeAssetPath(path) {
  return typeof path === 'string' && !path.includes('..') && ASSET_PATH.test(path)
}

function fileRecord(file) {
  const bytes = Number(file?.bytes)
  return {
    path: file?.path,
    bytes: Number.isFinite(bytes) ? bytes : NaN,
  }
}

function acceptableFile(file, limits) {
  const record = fileRecord(file)
  return safeAssetPath(record.path) && record.bytes > 0 && record.bytes < limits.maxFileBytes
}

function publishedAtMs(release) {
  const value = Date.parse(release?.publishedAt ?? '')
  return Number.isFinite(value) ? value : Number.NaN
}

/**
 * 决定这次 dist 要从旧发布里复制哪些 /assets 文件，以及新的清单。
 * 保留最近 keepReleases 次，或 14 天内的发布（两者取并集）。
 * 超出文件数或字节上限时，先丢掉较大的 /website-assets，再丢掉其它 /assets，最后才丢掉 /assets 里的 JS。
 * 当前构建里小于 25 MiB 的文件始终留在清单里，不会被上限删掉。
 */
export function planAssetRetention({
  now,
  current,
  previousReleases = [],
  occupiedFiles,
  retainedBytes = 0,
  limits = DEFAULT_LIMITS,
}) {
  const nowMs = now instanceof Date ? now.getTime() : now
  const currentFiles = (current.files ?? []).filter((file) => acceptableFile(file, limits))
  const currentPaths = new Set(currentFiles.map((file) => file.path))
  const seen = new Set(currentPaths)
  const previous = previousReleases
    .filter((release) => release && release.id && release.id !== current.id)
    .map((release) => ({
      id: String(release.id),
      publishedAt: typeof release.publishedAt === 'string' ? release.publishedAt : '',
      files: (release.files ?? []).filter((file) => acceptableFile(file, limits)),
    }))
    .sort((left, right) => publishedAtMs(right) - publishedAtMs(left))

  const selected = []
  for (let index = 0; index < previous.length; index++) {
    const age = nowMs - publishedAtMs(previous[index])
    const withinWindow = Number.isFinite(age) && age <= limits.keepAgeMs
    if (index < limits.keepReleases || withinWindow) selected.push(previous[index])
  }

  const candidates = []
  for (const release of selected) {
    for (const file of release.files) {
      if (seen.has(file.path)) continue
      seen.add(file.path)
      candidates.push({ ...file, releaseId: release.id, publishedAt: release.publishedAt })
    }
  }
  // 0 = /assets JS（打开的工作台最需要），1 = 其它 /assets，2 = website-assets（大图最后留）。
  const rank = (path) => {
    if (path.startsWith('assets/') && /\.m?js$/.test(path)) return 0
    if (path.startsWith('assets/')) return 1
    return 2
  }
  candidates.sort((left, right) => {
    const byRank = rank(left.path) - rank(right.path)
    if (byRank) return byRank
    const byTime = publishedAtMs(right) - publishedAtMs(left)
    if (byTime) return byTime
    return left.bytes - right.bytes
  })

  let files = occupiedFiles
  let bytes = retainedBytes
  const keptByRelease = new Map()
  const keptIds = new Set()
  for (const file of candidates) {
    if (files + 1 > limits.maxDeployFiles || bytes + file.bytes > limits.maxRetainedBytes) continue
    files += 1
    bytes += file.bytes
    const bucket = keptByRelease.get(file.releaseId) ?? []
    bucket.push({ path: file.path, bytes: file.bytes })
    keptByRelease.set(file.releaseId, bucket)
    keptIds.add(file.releaseId)
  }
  const kept = selected
    .filter((release) => keptIds.has(release.id))
    .map((release) => ({
      id: release.id,
      publishedAt: release.publishedAt,
      files: keptByRelease.get(release.id),
    }))
  const droppedReleaseIds = selected
    .filter((release) => !keptIds.has(release.id) && release.files.some((file) => !currentPaths.has(file.path)))
    .map((release) => release.id)

  const byPath = (left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  const releases = [
    {
      id: current.id,
      publishedAt: current.publishedAt,
      files: currentFiles.map((file) => ({ path: file.path, bytes: file.bytes })).sort(byPath),
    },
    ...kept.map((release) => ({
      ...release,
      files: [...release.files].sort(byPath),
    })),
  ]
  return {
    copy: kept.flatMap((release) =>
      release.files.map((file) => ({ ...file, releaseId: release.id })),
    ),
    releases,
    droppedReleaseIds,
    retainedBytes: bytes,
  }
}

async function walkFiles(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const files = []
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await walkFiles(full, relative)))
    else if (entry.isFile()) files.push(relative)
  }
  return files
}

function looksLikeHtml(bytes) {
  const head = bytes.subarray(0, 64).toString('utf8').trimStart().toLowerCase()
  return (
    head.startsWith('<!doctype') ||
    head.startsWith('<html') ||
    head.startsWith('<head') ||
    head.startsWith('<body')
  )
}

function parseManifest(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('assets-manifest.json is not JSON; refusing to drop retained assets')
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.releases)) {
    throw new Error('assets-manifest.json has no releases array; refusing to drop retained assets')
  }
  if (data.version !== undefined && data.version !== 1) {
    throw new Error(`Unsupported assets-manifest version ${data.version}`)
  }
  return data.releases
}

async function mapPool(items, limit, fn) {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()
      await fn(item)
    }
  })
  await Promise.all(workers)
}

/** Stop reading once the body reaches the Pages per-file cap. The oversized bytes are discarded. */
export async function readBounded(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared >= maxBytes) {
    await response.body?.cancel?.().catch(() => {})
    return { overflow: true, bytes: null }
  }
  const reader = response.body?.getReader?.()
  if (!reader) {
    throw new Error('response body is not a stream; refusing to buffer it without a size cap')
  }
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total >= maxBytes) {
      await reader.cancel().catch(() => {})
      return { overflow: true, bytes: null }
    }
    chunks.push(Buffer.from(value))
  }
  return { overflow: false, bytes: chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0) }
}

function normalizeRelative(dir, rel) {
  const parts = []
  for (const part of `${dir}/${rel}`.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

/**
 * Paths under /assets and /website-assets referenced by an HTML or JS/CSS file.
 * Absolute URLs on another origin are ignored. Relative imports resolve against `basePath`.
 */
export function assetReferencesFrom(text, basePath = '', pageOrigin = '') {
  const found = new Set()
  const accept = (path) => {
    if (safeAssetPath(path) && /\.[A-Za-z0-9]+$/.test(path)) found.add(path)
  }
  for (const match of text.matchAll(/https?:\/\/[^\s"'()]+/g)) {
    try {
      const url = new URL(match[0])
      if (pageOrigin && url.origin !== pageOrigin) continue
      accept(url.pathname.replace(/^\//, ''))
    } catch {
      // Not a URL.
    }
  }
  for (const match of text.matchAll(/(?:^|[\s"'`(])\/((?:assets|website-assets)\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)/g)) {
    accept(match[1])
  }
  // Vite __vite__mapDeps / __vitePreload store site-root paths without a leading slash:
  // "assets/CanvasMode-CkYmZLXv.css"
  for (const match of text.matchAll(/(?:^|[\s"'`(])((?:assets|website-assets)\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)/g)) {
    accept(match[1])
  }
  if (basePath) {
    const dir = basePath.includes('/') ? basePath.slice(0, basePath.lastIndexOf('/')) : ''
    for (const match of text.matchAll(/(?:^|[\s"'`(])(\.\.?\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)/g)) {
      accept(normalizeRelative(dir, match[1]))
    }
  }
  return [...found]
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function transientStatus(status) {
  return status === 404 || status === 408 || status === 429 || (status >= 500 && status <= 599)
}

async function requestWithRetries(fetchImpl, url, { attempts, delayMs, retryNotFound }) {
  let response
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await sleep(delayMs * attempt)
    try {
      response = await fetchImpl(url, {
        cache: 'no-store',
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      lastError = error
      response = undefined
      continue
    }
    if (response.ok) return response
    if (response.status === 404 && !retryNotFound) return response
    if (!transientStatus(response.status)) return response
  }
  if (response) return response
  throw lastError ?? new Error(`GET ${url} failed`)
}

async function readCurrentRelease(distDir, now, releaseId) {
  const files = []
  for (const rootName of ASSET_ROOTS) {
    const names = await walkFiles(join(distDir, rootName))
    for (const name of names) {
      const path = `${rootName}/${name}`
      const info = await stat(join(distDir, rootName, name))
      files.push({ path, bytes: info.size })
    }
  }
  let id = releaseId
  if (!id) {
    try {
      const version = JSON.parse(await readFile(join(distDir, 'version.json'), 'utf8'))
      id = typeof version.version === 'string' && version.version ? version.version : ''
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  if (!id) id = `build-${now.toISOString()}`
  return { id, publishedAt: now.toISOString(), files }
}

const ENTRY_PAGES = ['', 'index.html', 'workbench.html', 'workbench']
const BOOTSTRAP_FILE_CAP = 4_000

/**
 * When the live site has no assets-manifest.json yet, recover the hashes it is
 * serving now by reading the HTML entries and following their JS/CSS graph.
 * Returns null when the origin is not already an app (nothing to keep).
 */
export async function bootstrapLiveRelease({
  origin,
  fetchImpl,
  now,
  limits = DEFAULT_LIMITS,
  retryDelayMs = 400,
  log = console.log,
}) {
  const base = new URL(origin.endsWith('/') ? origin : `${origin}/`)
  const queue = []
  const seen = new Set()
  for (const page of ENTRY_PAGES) {
    const url = new URL(page, base)
    url.searchParams.set('retain-check', String(now.getTime()))
    let response
    try {
      response = await requestWithRetries(fetchImpl, url, {
        attempts: 3,
        delayMs: retryDelayMs,
        retryNotFound: false,
      })
    } catch (error) {
      throw new Error(
        `GET ${url.pathname || '/'} failed: ${error.message}; refusing to publish without the live asset graph. Set PAGES_SKIP_ASSET_RETAIN=1 to bypass.`,
        { cause: error },
      )
    }
    // A clear 404 means that entry is absent. 5xx after retries must not look like a first release.
    if (response.status === 404) continue
    if (!response.ok) {
      throw new Error(
        `GET ${url.pathname || '/'} failed: ${response.status} after retries; refusing to publish without the live asset graph. Set PAGES_SKIP_ASSET_RETAIN=1 to bypass.`,
      )
    }
    const { overflow, bytes } = await readBounded(response, limits.maxFileBytes)
    if (overflow || !bytes || !looksLikeHtml(bytes)) continue
    for (const path of assetReferencesFrom(bytes.toString('utf8'), '', base.origin)) queue.push(path)
  }
  if (!queue.length) return null

  const files = []
  const bodies = new Map()
  let frontier = queue
  while (frontier.length && seen.size < BOOTSTRAP_FILE_CAP) {
    const batch = []
    for (const path of frontier) {
      if (!path || seen.has(path) || !safeAssetPath(path)) continue
      seen.add(path)
      batch.push(path)
      if (seen.size >= BOOTSTRAP_FILE_CAP) break
    }
    const discovered = []
    await mapPool(batch, 6, async (path) => {
      const url = new URL(path, base)
      url.searchParams.set('retain-check', String(now.getTime()))
      let response
      try {
        response = await requestWithRetries(fetchImpl, url, {
          attempts: 3,
          delayMs: retryDelayMs,
          retryNotFound: true,
        })
      } catch (error) {
        throw new Error(`GET /${path} failed: ${error.message}`, { cause: error })
      }
      if (response.status === 404) return
      if (!response.ok) {
        throw new Error(`GET /${path} failed: ${response.status}; refusing to drop live assets`)
      }
      const { overflow, bytes } = await readBounded(response, limits.maxFileBytes)
      const type = response.headers.get('content-type') ?? ''
      if (overflow || !bytes || bytes.length === 0 || type.includes('text/html') || looksLikeHtml(bytes)) return
      files.push({ path, bytes: bytes.length })
      bodies.set(path, bytes)
      if (/\.(?:m?js|css)$/.test(path)) {
        for (const next of assetReferencesFrom(bytes.toString('utf8'), path, base.origin)) {
          if (!seen.has(next)) discovered.push(next)
        }
      }
    })
    frontier = discovered
  }
  if (!files.length) return null
  log(`No asset manifest at ${origin}; bootstrapped ${files.length} live hashed file(s) from the current pages.`)
  return {
    release: { id: `live-${now.toISOString()}`, publishedAt: now.toISOString(), files },
    bodies,
  }
}

/**
 * @param {{ distDir: string, origin: string, fetchImpl?: typeof fetch, now?: Date, releaseId?: string, limits?: typeof DEFAULT_LIMITS, log?: (message: string) => void, retryDelayMs?: number }} options
 */
export async function retainPagesAssets({
  distDir,
  origin,
  fetchImpl = fetch,
  now = new Date(),
  releaseId,
  limits = DEFAULT_LIMITS,
  log = console.log,
  retryDelayMs = 400,
}) {
  const root = resolve(distDir)
  const base = new URL(origin.endsWith('/') ? origin : `${origin}/`)
  const current = await readCurrentRelease(root, now, releaseId)
  const oversized = current.files.filter((file) => safeAssetPath(file.path) && file.bytes >= limits.maxFileBytes)
  if (oversized.length) {
    log(
      `WARNING: current build has ${oversized.length} file(s) at or above the ${limits.maxFileBytes} byte Pages limit. ` +
        `They stay in this upload (Pages will reject the deploy if it cannot store them) and are not listed for later retention: ` +
        oversized.map((file) => file.path).join(', '),
    )
  }
  const occupied = (await walkFiles(root)).length + 1
  const cached = new Map()

  const loadManifest = async () => {
    const manifestUrl = new URL('assets-manifest.json', base)
    manifestUrl.searchParams.set('retain-check', String(now.getTime()))
    let response
    try {
      response = await requestWithRetries(fetchImpl, manifestUrl, {
        attempts: 3,
        delayMs: retryDelayMs,
        retryNotFound: false,
      })
    } catch (error) {
      throw new Error(`GET /assets-manifest.json failed: ${error.message}; refusing to publish without retained assets`, { cause: error })
    }
    if (response.status === 404) return null
    if (!response.ok) {
      throw new Error(
        `GET /assets-manifest.json failed: ${response.status}; refusing to publish without retained assets`,
      )
    }
    const { overflow, bytes } = await readBounded(response, limits.maxFileBytes)
    if (overflow || !bytes) {
      throw new Error('assets-manifest.json is at or above the 25 MiB Pages file limit')
    }
    const type = response.headers.get('content-type') ?? ''
    if (type.includes('text/html') || looksLikeHtml(bytes)) {
      throw new Error(
        'assets-manifest.json returned HTML. Missing /assets must 404, not fall back to index.html.',
      )
    }
    return parseManifest(bytes.toString('utf8'))
  }

  let previousReleases = (await loadManifest()) ?? []
  if (!previousReleases.length) {
    const bootstrapped = await bootstrapLiveRelease({
      origin,
      fetchImpl,
      now,
      limits,
      retryDelayMs,
      log,
    })
    if (!bootstrapped) {
      log(`No previous asset manifest at ${origin}; the origin is not serving hashed assets yet. Publishing the current build only.`)
    } else {
      previousReleases = [bootstrapped.release]
      for (const [path, bytes] of bootstrapped.bodies) cached.set(path, bytes)
    }
  }

  const skipped = []
  const copied = []
  const have = new Set(current.files.map((file) => file.path))

  const downloadOne = async (file) => {
    if (have.has(file.path)) return
    const cachedBytes = cached.get(file.path)
    let bytes = cachedBytes
    if (!bytes) {
      const url = new URL(file.path, base)
      url.searchParams.set('retain-check', String(now.getTime()))
      let response
      try {
        response = await requestWithRetries(fetchImpl, url, {
          attempts: 3,
          delayMs: retryDelayMs,
          retryNotFound: true,
        })
      } catch (error) {
        throw new Error(`GET /${file.path} failed: ${error.message}`, { cause: error })
      }
      if (response.status === 404) {
        skipped.push(file.path)
        return
      }
      if (!response.ok) {
        throw new Error(`GET /${file.path} failed: ${response.status}; refusing to drop retained assets`)
      }
      const read = await readBounded(response, limits.maxFileBytes)
      if (read.overflow || !read.bytes) {
        skipped.push(file.path)
        log(`WARNING: skipped /${file.path}; body reached the ${limits.maxFileBytes} byte cap before it finished.`)
        return
      }
      bytes = read.bytes
      const type = response.headers.get('content-type') ?? ''
      if (type.includes('text/html') || looksLikeHtml(bytes) || bytes.length === 0) {
        skipped.push(file.path)
        return
      }
    }
    const target = join(root, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
    have.add(file.path)
    copied.push({ ...file, bytes: bytes.length })
  }

  const planOf = (releases) =>
    planAssetRetention({
      now,
      current,
      previousReleases: releases,
      occupiedFiles: occupied + copied.length,
      retainedBytes: copied.reduce((sum, file) => sum + file.bytes, 0),
      limits,
    })

  let plan = planOf(previousReleases)
  await mapPool(plan.copy, 6, downloadOne)

  // A deploy that finished while this one was downloading is already live. Union its
  // manifest with the one we started from so neither release's hashes are dropped.
  const again = await loadManifest()
  let releaseLists = plan.releases
  if (again?.length) {
    const late = planOf(
      again.map((release) => ({
        ...release,
        files: (release.files ?? []).filter(
          (file) => !have.has(file.path) && !skipped.includes(file.path),
        ),
      })),
    )
    const fresh = late.copy.filter((file) => !have.has(file.path) && !skipped.includes(file.path))
    if (fresh.length) {
      log(`Live manifest gained ${fresh.length} file(s) during this retain; merging them before upload.`)
      await mapPool(fresh, 6, downloadOne)
    }
    plan = {
      ...plan,
      copy: [...plan.copy, ...fresh],
      droppedReleaseIds: [...new Set([...plan.droppedReleaseIds, ...late.droppedReleaseIds])],
    }
    releaseLists = [...plan.releases, ...late.releases]
  }

  if (plan.copy.length >= 4 && skipped.length * 2 > plan.copy.length) {
    throw new Error(
      `Refusing to publish: ${skipped.length} of ${plan.copy.length} retained assets were missing`,
    )
  }
  const copiedPaths = new Set(copied.map((file) => file.path))
  const grouped = new Map()
  for (const release of releaseLists) {
    const existing = grouped.get(release.id)
    if (!existing) {
      grouped.set(release.id, { ...release, files: [...release.files] })
      continue
    }
    const paths = new Set(existing.files.map((file) => file.path))
    for (const file of release.files) {
      if (!paths.has(file.path)) existing.files.push(file)
    }
  }
  const releases = []
  for (const release of grouped.values()) {
    if (release.id === current.id) {
      releases.push(release)
      continue
    }
    const files = release.files
      .filter((file) => copiedPaths.has(file.path))
      .map((file) => {
        const saved = copied.find((item) => item.path === file.path)
        return { path: file.path, bytes: saved?.bytes ?? file.bytes }
      })
    if (files.length) releases.push({ ...release, files })
  }

  const manifest = { version: 1, releases }
  await writeFile(join(root, 'assets-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const retainedBytes = copied.reduce((sum, file) => sum + file.bytes, 0)
  log(
    `Retained ${copied.length} asset file(s) from previous releases (${retainedBytes} bytes). ` +
      `Skipped ${skipped.length}. Dropped ${plan.droppedReleaseIds.length} release(s) past the retention cap. ` +
      `Manifest lists ${releases.length} release(s).`,
  )
  return { copied, skipped, droppedReleaseIds: plan.droppedReleaseIds, manifest }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isDirectRun) {
  const [distDir, origin] = process.argv.slice(2)
  if (!distDir || !origin) {
    console.error('Usage: retain-pages-assets.mjs <dist-dir> <origin>')
    process.exit(1)
  }
  await retainPagesAssets({ distDir, origin })
}

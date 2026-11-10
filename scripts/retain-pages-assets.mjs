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
// 清单 404：第一次上线，只发本次构建。清单请求失败或返回 HTML：中止发布，避免用一份
// 没有历史的站点盖掉还能用的旧哈希。单个旧文件 404 或其实是 HTML：跳过（线上已经没有），
// 不把首页写进 .js。
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
 * 保留最近 keepReleases 次，或 14 天内的发布（两者取并集）；超出文件数或字节上限时从最旧的丢。
 * 当前构建的文件始终留在清单里，不会被上限删掉。
 */
export function planAssetRetention({
  now,
  current,
  previousReleases = [],
  occupiedFiles,
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

  let files = occupiedFiles
  let bytes = 0
  const kept = []
  const droppedReleaseIds = []
  let budgetSpent = false
  for (const release of selected) {
    const fresh = []
    for (const file of release.files) {
      if (seen.has(file.path)) continue
      fresh.push(file)
    }
    const addBytes = fresh.reduce((sum, file) => sum + file.bytes, 0)
    const overBudget =
      files + fresh.length > limits.maxDeployFiles || bytes + addBytes > limits.maxRetainedBytes
    if (budgetSpent || (fresh.length > 0 && overBudget)) {
      budgetSpent = true
      droppedReleaseIds.push(release.id)
      continue
    }
    for (const file of fresh) seen.add(file.path)
    files += fresh.length
    bytes += addBytes
    if (fresh.length > 0) {
      kept.push({
        id: release.id,
        publishedAt: release.publishedAt,
        files: fresh.map((file) => ({ path: file.path, bytes: file.bytes })),
      })
    }
  }

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

/**
 * @param {{ distDir: string, origin: string, fetchImpl?: typeof fetch, now?: Date, releaseId?: string, limits?: typeof DEFAULT_LIMITS, log?: (message: string) => void }} options
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
  const occupied = (await walkFiles(root)).length + 1

  const manifestUrl = new URL('assets-manifest.json', base)
  manifestUrl.searchParams.set('retain-check', String(now.getTime()))
  let previousReleases = []
  const manifestResponse = await fetchImpl(manifestUrl, {
    cache: 'no-store',
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  })
  if (manifestResponse.status === 404) {
    log(`No previous asset manifest at ${origin}; publishing the current build only.`)
  } else if (!manifestResponse.ok) {
    throw new Error(
      `GET ${manifestUrl.pathname} failed: ${manifestResponse.status}; refusing to publish without retained assets`,
    )
  } else {
    const type = manifestResponse.headers.get('content-type') ?? ''
    const text = await manifestResponse.text()
    if (type.includes('text/html') || looksLikeHtml(Buffer.from(text))) {
      throw new Error(
        'assets-manifest.json returned HTML. Missing /assets must 404, not fall back to index.html.',
      )
    }
    previousReleases = parseManifest(text)
  }

  const plan = planAssetRetention({
    now,
    current,
    previousReleases,
    occupiedFiles: occupied,
    limits,
  })
  const skipped = []
  const copied = []
  await mapPool(plan.copy, 6, async (file) => {
    const url = new URL(file.path, base)
    url.searchParams.set('retain-check', String(now.getTime()))
    let response
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt))
      try {
        response = await fetchImpl(url, {
          cache: 'no-store',
          redirect: 'follow',
          signal: AbortSignal.timeout(20_000),
        })
      } catch (error) {
        if (attempt === 2) {
          throw new Error(`GET /${file.path} failed: ${error.message}`, { cause: error })
        }
        continue
      }
      if (response.status !== 404 || attempt === 2) break
    }
    if (response.status === 404) {
      skipped.push(file.path)
      return
    }
    if (!response.ok) {
      throw new Error(`GET /${file.path} failed: ${response.status}; refusing to drop retained assets`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    const type = response.headers.get('content-type') ?? ''
    if (type.includes('text/html') || looksLikeHtml(bytes) || bytes.byteLength === 0 || bytes.byteLength >= limits.maxFileBytes) {
      skipped.push(file.path)
      return
    }
    const target = join(root, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
    copied.push({ ...file, bytes: bytes.byteLength })
  })

  if (plan.copy.length >= 4 && skipped.length * 2 > plan.copy.length) {
    throw new Error(
      `Refusing to publish: ${skipped.length} of ${plan.copy.length} retained assets were missing`,
    )
  }
  const copiedPaths = new Set(copied.map((file) => file.path))
  const releases = plan.releases
    .map((release, index) => {
      if (index === 0) return release
      const files = release.files
        .filter((file) => copiedPaths.has(file.path))
        .map((file) => {
          const saved = copied.find((item) => item.path === file.path)
          return { path: file.path, bytes: saved?.bytes ?? file.bytes }
        })
      return { ...release, files }
    })
    .filter((release, index) => index === 0 || release.files.length > 0)

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

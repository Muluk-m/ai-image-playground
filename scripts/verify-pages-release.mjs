import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const LONG_LIVED = /immutable|(?:s-maxage|max-age)=[1-9]/i

function getter(origin, fetcher, signal) {
  return async (path) => {
    // Intentionally use the ordinary URL and caching path: cache-busting concealed this incident.
    signal.throwIfAborted()
    const response = await fetcher(new URL(path, origin), { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), redirect: 'error' })
    return { response, bytes: Buffer.from(await response.arrayBuffer()) }
  }
}

function rejectCachedHtml(response, label) {
  if (LONG_LIVED.test(response.headers.get('cache-control') ?? ''))
    throw new Error(`${label} is cached long-lived`)
}

async function verifyAssets(get, dist, directories) {
  const assets = []
  for (const directory of directories) {
    const entries = await readdir(resolve(dist, directory)).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    assets.push(...entries.filter(name => /\.(js|css)$/.test(name)).map(name => `${directory}/${name}`))
  }
  if (!assets.length) throw new Error('Build has no script or stylesheet assets')
  // Bounded concurrency; check lazy chunks as well as the entry's immediate dependencies.
  for (let offset = 0; offset < assets.length; offset += 4) {
    await Promise.all(assets.slice(offset, offset + 4).map(async (name) => {
      const { response, bytes } = await get(`/${name}`)
      const type = response.headers.get('content-type') ?? ''
      const expected = name.endsWith('.css') ? /^text\/css\b/ : /^(?:application|text)\/javascript\b/
      if (response.status !== 200 || !expected.test(type)) throw new Error(`Invalid asset ${name}: ${response.status} ${type}`)
      if (!bytes.equals(await readFile(resolve(dist, name)))) {
        throw new Error(`Asset content differs from this build: ${name}`)
      }
    }))
  }
  return assets.length
}

// `_headers` marks these directories immutable for a year, so a SPA fallback there caches HTML for a year.
async function verifyMissingAssets(get, directories) {
  for (const directory of directories) {
    const { response: missing } = await get(`/${directory}/release-check-missing-${randomUUID()}.js`)
    const policy = missing.headers.get('cache-control') ?? ''
    if (missing.status !== 404 || LONG_LIVED.test(policy) || !/no-store|no-cache|max-age=0/i.test(policy)) {
      throw new Error(`Missing asset must return a non-reusable 404: ${directory} ${missing.status} ${policy}`)
    }
  }
}

export async function verifyPagesRelease(origin, dist, fetcher = fetch, signal = AbortSignal.timeout(60000)) {
  const get = getter(origin, fetcher, signal)
  const localHtml = await readFile(resolve(dist, 'index.html'), 'utf8')
  // The identity is a sha256 of the whole HTML, so a match means this exact entry and startup guard.
  const identity = /<meta name="aip-html-build" content="[a-f0-9]{64}">/.exec(localHtml)?.[0]
  if (!identity) throw new Error('Build has no HTML identity')
  const { response: page, bytes: html } = await get('/')
  if (!page.ok || !page.headers.get('content-type')?.includes('text/html')) {
    throw new Error('Homepage did not return HTML')
  }
  rejectCachedHtml(page, 'Homepage')
  if (!html.toString().includes(identity)) throw new Error('Homepage references another release')
  const redirects = await readFile(resolve(dist, '_redirects'), 'utf8')
  for (const line of redirects.split('\n')) {
    const [source, target, status] = line.trim().split(/\s+/)
    if (status !== '200') continue
    const entry = await readFile(resolve(dist, target === '/' ? 'index.html' : target === '/workbench' ? 'workbench.html' : target.slice(1)), 'utf8')
    const routeIdentity = /<meta name="aip-html-build" content="[a-f0-9]{64}">/.exec(entry)?.[0]
    if (!routeIdentity) throw new Error(`Missing identity for ${target}`)
    const path = source.replace(':project', 'startup-release-check')
    const { response, bytes } = await get(path)
    if (response.status !== 200 || !bytes.toString().includes(routeIdentity)) {
      throw new Error(`Application deep link did not serve this release: ${path}`)
    }
    // A page cached as immutable keeps serving this release's HTML after the next one ships.
    if (LONG_LIVED.test(response.headers.get('cache-control') ?? '')) {
      throw new Error(`Application deep link is cached long-lived: ${path}`)
    }
  }
  const assetCount = await verifyAssets(get, dist, ['assets', 'website-assets'])
  const manifest = await readFile(resolve(dist, 'site-pages.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '[]'; throw error })
  for (const { path } of JSON.parse(manifest)) {
    if (path === '/') continue
    const entry = await readFile(resolve(dist, `.${path}index.html`), 'utf8')
    const expected = /<meta name="aip-html-build" content="[a-f0-9]{64}">/.exec(entry)?.[0]
    const { response, bytes } = await get(path)
    rejectCachedHtml(response, `Static page ${path}`)
    if (!expected || !response.ok || !bytes.toString().includes(expected)) throw new Error(`Static page differs: ${path}`)
  }
  await verifyMissingAssets(get, ['assets', 'website-assets'])
  console.log(`Verified homepage, ${assetCount} JS/CSS files, and missing-asset 404 at ${origin}`)
}

// The Admin build has no HTML identity meta; its entry script URL is content-hashed, so a page that
// references it was built from this release.
export async function verifyAdminPagesRelease(origin, dist, fetcher = fetch, signal = AbortSignal.timeout(60000)) {
  const get = getter(origin, fetcher, signal)
  const localHtml = await readFile(resolve(dist, 'index.html'), 'utf8')
  const entry = /<script type="module"[^>]* src="(\/assets\/[^"]+\.js)"/.exec(localHtml)?.[1]
  if (!entry) throw new Error('Build has no hashed entry script')
  const checkPage = async (path, label) => {
    const { response, bytes } = await get(path)
    if (response.status !== 200 || !response.headers.get('content-type')?.includes('text/html')) {
      throw new Error(`${label} did not return HTML: ${path} ${response.status}`)
    }
    rejectCachedHtml(response, `${label} ${path}`)
    if (!bytes.toString().includes(entry)) throw new Error(`${label} references another release: ${path}`)
  }
  await checkPage('/', 'Homepage')
  const redirects = await readFile(resolve(dist, '_redirects'), 'utf8')
  const deepLinks = []
  for (const line of redirects.split('\n')) {
    const [source, target, status] = line.trim().split(/\s+/)
    if (!source || source.startsWith('#')) continue
    if (status !== '200' || target !== '/') throw new Error(`Unexpected Admin redirect rule: ${line.trim()}`)
    if (source === '/*' || source.startsWith('/assets')) throw new Error(`Admin redirect swallows assets: ${source}`)
    deepLinks.push(source.replace(/:[^/]+/g, 'release-check'))
  }
  // Bounded concurrency, same as the asset checks.
  for (let offset = 0; offset < deepLinks.length; offset += 4) {
    await Promise.all(deepLinks.slice(offset, offset + 4).map(path => checkPage(path, 'Application deep link')))
  }
  const assetCount = await verifyAssets(get, dist, ['assets'])
  await verifyMissingAssets(get, ['assets'])
  console.log(`Verified Admin homepage, deep links, ${assetCount} JS/CSS files, and missing-asset 404 at ${origin}`)
}

export async function verifyPagesReleaseWithRetry(origin, dist, { fetcher = fetch, timeoutMs = 180000, intervalMs = 5000, app = 'web' } = {}) {
  const verify = app === 'admin' ? verifyAdminPagesRelease : verifyPagesRelease
  const signal = AbortSignal.timeout(timeoutMs)
  let attempt = 0
  while (true) {
    try {
      await verify(origin, dist, fetcher, signal)
      return
    } catch (error) {
      if (signal.aborted) throw error
      console.warn(`Pages verification attempt ${++attempt} failed; waiting for propagation: ${error.message}`)
      try { await delay(intervalMs, undefined, { signal }) } catch { throw error }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = process.argv[4] ?? 'web'
  if (app !== 'web' && app !== 'admin') throw new Error(`Unknown app: ${app}`)
  await verifyPagesReleaseWithRetry(process.argv[2], process.argv[3], { app })
}

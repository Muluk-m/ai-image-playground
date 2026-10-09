import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

export async function verifyPagesRelease(origin, dist, fetcher = fetch, signal = AbortSignal.timeout(60000)) {
  const get = async (path) => {
    // Intentionally use the ordinary URL and caching path: cache-busting concealed this incident.
    signal.throwIfAborted()
    const response = await fetcher(new URL(path, origin), { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), redirect: 'error' })
    return { response, bytes: Buffer.from(await response.arrayBuffer()) }
  }
  const localHtml = await readFile(resolve(dist, 'index.html'), 'utf8')
  // The identity is a sha256 of the whole HTML, so a match means this exact entry and startup guard.
  const identity = /<meta name="aip-html-build" content="[a-f0-9]{64}">/.exec(localHtml)?.[0]
  if (!identity) throw new Error('Build has no HTML identity')
  const { response: page, bytes: html } = await get('/')
  if (!page.ok || !page.headers.get('content-type')?.includes('text/html')) {
    throw new Error('Homepage did not return HTML')
  }
  if (!html.toString().includes(identity)) throw new Error('Homepage references another release')
  const redirects = await readFile(resolve(dist, '_redirects'), 'utf8')
  for (const line of redirects.split('\n')) {
    const [source, , status] = line.trim().split(/\s+/)
    if (status !== '200') continue
    const path = source.replace(':project', 'startup-release-check')
    const { response, bytes } = await get(path)
    if (response.status !== 200 || !bytes.toString().includes(identity)) {
      throw new Error(`Application deep link did not serve this release: ${path}`)
    }
    // A page cached as immutable keeps serving this release's HTML after the next one ships.
    if (/immutable|(?:s-maxage|max-age)=[1-9]/i.test(response.headers.get('cache-control') ?? '')) {
      throw new Error(`Application deep link is cached long-lived: ${path}`)
    }
  }
  const assets = (await readdir(resolve(dist, 'assets'))).filter((name) => /\.(js|css)$/.test(name))
  if (!assets.length) throw new Error('Build has no script or stylesheet assets')
  // Bounded concurrency; check lazy chunks as well as the entry's immediate dependencies.
  for (let offset = 0; offset < assets.length; offset += 4) {
    await Promise.all(assets.slice(offset, offset + 4).map(async (name) => {
      const { response, bytes } = await get(`/assets/${name}`)
      const type = response.headers.get('content-type') ?? ''
      const expected = name.endsWith('.css') ? /^text\/css\b/ : /^(?:application|text)\/javascript\b/
      if (response.status !== 200 || !expected.test(type)) throw new Error(`Invalid asset ${name}: ${response.status} ${type}`)
      if (!bytes.equals(await readFile(resolve(dist, 'assets', name)))) {
        throw new Error(`Asset content differs from this build: ${name}`)
      }
    }))
  }
  const { response: missing } = await get(`/assets/release-check-missing-${randomUUID()}.js`)
  const policy = missing.headers.get('cache-control') ?? ''
  if (missing.status !== 404 || /immutable|(?:s-maxage|max-age)=[1-9]/i.test(policy) || !/no-store|no-cache|max-age=0/i.test(policy)) {
    throw new Error(`Missing asset must return a non-reusable 404: ${missing.status} ${policy}`)
  }
  console.log(`Verified homepage, ${assets.length} JS/CSS files, and missing-asset 404 at ${origin}`)
}

export async function verifyPagesReleaseWithRetry(origin, dist, { fetcher = fetch, timeoutMs = 180000, intervalMs = 5000 } = {}) {
  const signal = AbortSignal.timeout(timeoutMs)
  let attempt = 0
  while (true) {
    try {
      await verifyPagesRelease(origin, dist, fetcher, signal)
      return
    } catch (error) {
      if (signal.aborted) throw error
      console.warn(`Pages verification attempt ${++attempt} failed; waiting for propagation: ${error.message}`)
      try { await delay(intervalMs, undefined, { signal }) } catch { throw error }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await verifyPagesReleaseWithRetry(process.argv[2], process.argv[3])
}

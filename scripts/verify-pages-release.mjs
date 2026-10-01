import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

export async function verifyPagesRelease(origin, dist, fetcher = fetch) {
  const get = async (path) => {
    // Intentionally use the ordinary URL and caching path: cache-busting concealed this incident.
    const response = await fetcher(new URL(path, origin), { signal: AbortSignal.timeout(15000), redirect: 'error' })
    return { response, bytes: Buffer.from(await response.arrayBuffer()) }
  }
  const localHtml = await readFile(resolve(dist, 'index.html'), 'utf8')
  const { response: page, bytes: html } = await get('/')
  if (!page.ok || !page.headers.get('content-type')?.includes('text/html')) {
    throw new Error('Homepage did not return HTML')
  }
  const entry = /<script\b[^>]*\bsrc="([^\"]+\.js)"/.exec(localHtml)?.[1]
  if (!entry || !html.toString().includes(entry)) throw new Error('Homepage references another release')
  const redirects = await readFile(resolve(dist, '_redirects'), 'utf8')
  for (const line of redirects.split('\n')) {
    const [source, , status] = line.trim().split(/\s+/)
    if (status !== '200') continue
    const path = source.replace(':project', 'startup-release-check')
    const { response, bytes } = await get(path)
    if (response.status !== 200 || !bytes.toString().includes(entry)) {
      throw new Error(`Application deep link did not serve this release: ${path}`)
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
      if (digest(bytes) !== digest(await readFile(resolve(dist, 'assets', name)))) {
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await verifyPagesRelease(process.argv[2], process.argv[3])
}

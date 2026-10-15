import { createHash } from 'node:crypto'
import { cp, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const site = resolve(import.meta.dirname, 'dist/client')
const target = resolve(import.meta.dirname, '../web/dist')
const manifest = JSON.parse(await readFile(resolve(site, 'site-pages.json'), 'utf8'))
// A missing prerender is fatal: never publish a client-only shell in its place.
for (const page of manifest) {
  const html = await readFile(resolve(site, `.${page.path}index.html`), 'utf8')
  if (!html.includes('<h1') || !html.includes('name="description"')) {
    throw new Error(`Incomplete prerender: ${page.path}`)
  }
}
await rename(resolve(target, 'index.html'), resolve(target, 'workbench.html'))
await cp(site, target, { recursive: true })
for (const page of manifest) {
  const file = resolve(target, `.${page.path}index.html`)
  const html = await readFile(file, 'utf8')
  const identity = createHash('sha256').update(html).digest('hex')
  await writeFile(
    file,
    html.replace('</head>', `<meta name="aip-html-build" content="${identity}"></head>`),
  )
}
// Ensure every hashed client entry referenced by the manifest exists before release.
const assets = await readdir(resolve(target, 'website-assets'))
if (!assets.some((name) => name.endsWith('.js'))) throw new Error('Missing website client assets')
console.log(`Composed ${manifest.length} static pages and workbench.html into ${target}`)

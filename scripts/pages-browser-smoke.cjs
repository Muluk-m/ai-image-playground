const { createServer } = require('node:http')
const { readFile, realpath, mkdir, writeFile } = require('node:fs/promises')
const { resolve, sep, extname, join } = require('node:path')

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
}
const PROJECT_ID = '00000000-0000-4000-8000-000000000001'
const PATHS = ['/', `/p/${PROJECT_ID}`]

// Serve the built bytes with Pages' explicit route rewrites; missing chunks never become HTML.
async function serveDist(dist) {
  const root = await realpath(dist)
  const redirects = (await readFile(join(root, '_redirects'), 'utf8'))
    .split('\n').filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => {
      const [source, target, status] = line.trim().split(/\s+/)
      const pattern = source.split('/').map((part) => part.startsWith(':')
        ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')
      return { pattern: new RegExp(`^${pattern}$`), target, status: Number(status) }
    })
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
      const redirect = redirects.find((rule) => rule.pattern.test(path))
      if (redirect && redirect.status !== 200) {
        res.writeHead(redirect.status, { location: redirect.target }).end()
        return
      }
      if (redirect) path = redirect.target
      if (path.endsWith('/')) path += 'index.html'
      const file = await realpath(resolve(root, `.${path}`))
      if (!file.startsWith(root + sep)) throw new Error('Outside dist')
      const bytes = await readFile(file)
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store' }).end(bytes)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('Not found')
    }
  })
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept())),
  }
}

async function checkWorkspace(browser, origin, { local = false, optionalStyles = [], outputDir, timeoutMs = 30000 } = {}) {
  for (const [index, path] of PATHS.entries()) {
    // Cold browser storage and module cache on each direct navigation, including the deep link.
    const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block' })
    const page = await context.newPage()
    const errors = []
    const logs = []
    let rejectFailure
    const failure = new Promise((_, reject) => { rejectFailure = reject })
    failure.catch(() => {})
    const fail = (message) => {
      errors.push(message)
      rejectFailure(new Error(message))
    }
    page.on('pageerror', (error) => fail(error.stack || error.message))
    page.on('console', (entry) => { if (entry.type() === 'error') logs.push(entry.text()) })
    // `/cdn-cgi/` is the CDN's own injected code (bot challenge, analytics), not part of the build.
    const isRequiredAsset = (request) => {
      const url = new URL(request.url())
      return ['script', 'stylesheet'].includes(request.resourceType())
        && url.origin === new URL(origin).origin && !url.pathname.startsWith('/cdn-cgi/')
    }
    page.on('requestfailed', (request) => {
      if (isRequiredAsset(request))
        fail(`Asset request failed: ${request.url()} ${request.failure()?.errorText}`)
    })
    page.on('response', (response) => {
      if (isRequiredAsset(response.request()) && !response.ok())
        fail(`Asset HTTP ${response.status()}: ${response.url()}`)
    })
    if (local) {
      await context.route('**/*', async (route) => {
        const request = route.request()
        const url = new URL(request.url())
        // Explicitly optional font styles use the system font in this offline startup check.
        if (request.resourceType() === 'stylesheet' && optionalStyles.includes(url.href))
          return route.fulfill({ contentType: 'text/css', body: '' })
        const fixtures = {
          '/api/capabilities': { 'accounts:login': true, 'generation:byok': true },
          '/api/channels': { channels: [] },
          '/api/agent/skills': { skills: [] },
          '/api/inspirations/manifest': {
            version: 1, updatedAt: '2026-01-01T00:00:00Z', items: [{
              id: 'startup-fixture', title: 'Startup fixture', prompt: 'Fixture',
              thumbnailUrl: '/pwa-icon.svg', params: { size: '1024x1024' },
              recommendedModel: 'fixture', recommendedProvider: 'openai-compat', category: 'Fixture',
            }],
          },
          '/api/auth/me': { error: 'unauthorized' },
        }
        if (Object.hasOwn(fixtures, url.pathname)) {
          if (request.method() !== 'GET') {
            fail(`Unexpected API write: ${request.method()} ${url.pathname}`)
            return route.abort()
          }
          return route.fulfill({ status: url.pathname === '/api/auth/me' ? 401 : 200,
            headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
            contentType: 'application/json', body: JSON.stringify(fixtures[url.pathname]) })
        }
        if (url.origin !== origin || url.pathname.startsWith('/api/')) {
          fail(`Unexpected startup network request: ${request.method()} ${url.origin}${url.pathname}`)
          return route.abort()
        }
        return route.continue()
      })
    }
    const label = index === 0 ? 'home' : 'project'
    try {
      // A known offline project exercises direct routing without an account or server writes.
      // The fixture document loads no app modules, so the subsequent navigation stays cold.
      if (index === 1) {
        const fixtureUrl = new URL('/__startup_fixture__', origin).href
        await context.route(fixtureUrl, (route) => route.fulfill({ contentType: 'text/html', body: '<html></html>' }))
        await page.goto(fixtureUrl)
        await page.evaluate((id) => new Promise((accept, reject) => {
          const request = indexedDB.open('image-playground-canvas', 1)
          request.onupgradeneeded = () => request.result.createObjectStore('scene')
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result
            const transaction = db.transaction('scene', 'readwrite')
            transaction.objectStore('scene').put({
              id, name: 'Startup fixture', customName: true, conversationId: null,
              sceneKey: `canvas:project:${id}`, createdAt: 1, updatedAt: 1,
              hasContent: false, workspaceOpened: true, kind: 'image', experience: 'canvas',
            }, `canvas-project:project:${id}`)
            transaction.oncomplete = () => { db.close(); accept() }
            transaction.onabort = () => { db.close(); reject(transaction.error) }
          }
        }), PROJECT_ID)
        await context.unroute(fixtureUrl)
      }
      await Promise.race([
        (async () => {
          const response = await page.goto(new URL(path, origin).href,
            { waitUntil: 'domcontentloaded', timeout: timeoutMs })
          if (!response?.ok()) throw new Error(`Page HTTP ${response?.status()}: ${path}`)
          const ready = index === 0 ? '[aria-label="创作"]' : '[aria-label="创作画布"] canvas'
          await page.locator(ready).first().waitFor({ timeout: timeoutMs })
          await page.locator('#boot').waitFor({ state: 'detached', timeout: timeoutMs })
          // Let initialization effects and their asset requests finish before declaring readiness.
          await page.waitForLoadState('networkidle', { timeout: timeoutMs })
          if (errors.length) throw new Error(errors.join('\n'))
        })(),
        failure,
      ])
      if (outputDir) {
        await mkdir(outputDir, { recursive: true })
        await page.screenshot({ path: join(outputDir, `${label}.png`) })
      }
      console.log(`PASS ${path}: workspace mounted, boot removed, no JavaScript or asset errors`)
    } catch (error) {
      if (outputDir) {
        await mkdir(outputDir, { recursive: true })
        await page.screenshot({ path: join(outputDir, `${label}-failed.png`) }).catch(() => {})
        await writeFile(join(outputDir, `${label}-failed.json`), JSON.stringify({
          path, error: error.message, errors, consoleErrors: logs,
          html: await page.content().catch(() => ''),
        }, null, 2))
      }
      throw new Error(`Startup smoke failed at ${path}: ${error.message}`, { cause: error })
    } finally {
      await context.close()
    }
  }
}

async function main() {
  const { chromium } = require('playwright')
  const local = process.argv[2] === '--dist'
  const target = local ? process.argv[3] : process.argv[2]
  if (!target) throw new Error('Usage: pages-browser-smoke.cjs --dist <directory> | <origin>')
  const html = local ? await readFile(join(resolve(target), 'index.html'), 'utf8') : ''
  const optionalStyles = (html.match(/<link\b[^>]*data-optional-style[^>]*>/g) || [])
    .map((tag) => /href=["']([^"']+)["']/.exec(tag)?.[1]).filter(Boolean)
  const server = local ? await serveDist(resolve(target)) : null
  let browser
  try {
    browser = await chromium.launch()
    await checkWorkspace(browser, server?.origin || target, {
      local, optionalStyles, timeoutMs: local ? 30000 : 60000,
      outputDir: process.env.PAGES_SMOKE_OUTPUT_DIR,
    })
  } finally {
    await browser?.close()
    await server?.close()
  }
}

module.exports = { serveDist, checkWorkspace }
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1 })

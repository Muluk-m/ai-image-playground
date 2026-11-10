// @vitest-environment node
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, it } from 'vitest'
import { startupGuardPlugin } from '../../boot/vitePlugin'

const CHROME = [
  '/usr/bin/google-chrome-stable',
  '/usr/local/bin/google-chrome',
  '/usr/bin/google-chrome',
].find((path) => existsSync(path))

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
}

type Hit = { path: string; status: number }

it.skipIf(!CHROME)(
  'reinserts a missing stylesheet and recovers a missing chunk in a real Vite build',
  async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'chunk-reload-'))
    const userData = mkdtempSync(join(tmpdir(), 'chunk-reload-chrome-'))
    mkdirSync(join(fixture, 'src'))
    writeFileSync(
      join(fixture, 'index.html'),
      '<!doctype html><html><head></head><body><div id="boot"></div><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>',
    )
    writeFileSync(join(fixture, 'src/main.css'), 'body{margin:0}\n')
    writeFileSync(join(fixture, 'src/lazy.css'), '#root{color:rgb(1, 2, 3)}\n')
    writeFileSync(
      join(fixture, 'src/main.js'),
      `import { importWithRetry } from ${JSON.stringify(fileURLToPath(new URL('../../lib/chunkLoad.ts', import.meta.url)))}\nimport './main.css'\nimportWithRetry(() => import('./lazy.js')).then((mod) => { document.getElementById('root').textContent = mod.label })\n`,
    )
    writeFileSync(
      join(fixture, 'src/lazy.js'),
      "import './lazy.css'\nexport const label='canvas-ready'\n",
    )
    let server: Server | undefined
    let chrome: ReturnType<typeof spawn> | undefined
    const hits: Hit[] = []
    try {
      await build({
        root: fixture,
        configFile: false,
        plugins: [startupGuardPlugin()],
        logLevel: 'error',
        server: {
          fs: { allow: [fileURLToPath(new URL('../../..', import.meta.url))] },
        },
        build: { outDir: 'dist', emptyOutDir: true },
      })
      const dist = join(fixture, 'dist')
      const html = readFileSync(join(dist, 'index.html'), 'utf8')
      expect(html).toContain('id="startup-guard"')
      const entryAssets = new Set(
        [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]),
      )
      const seen = new Map<string, number>()
      server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const pathname = url.pathname
        const asset = pathname.startsWith('/assets/') && !entryAssets.has(pathname)
        const hashed = pathname.endsWith('.js') || pathname.endsWith('.css')
        const count = (seen.get(pathname) ?? 0) + 1
        seen.set(pathname, count)
        if (asset && hashed && count === 1) {
          hits.push({ path: pathname, status: 404 })
          response.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
          response.end('missing')
          return
        }
        const relative = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^\/+/, '')
        const file = join(dist, relative)
        if (!file.startsWith(`${dist}/`) || !existsSync(file)) {
          hits.push({ path: pathname, status: 404 })
          response.writeHead(404, { 'cache-control': 'no-store' })
          response.end('missing')
          return
        }
        hits.push({ path: pathname, status: 200 })
        response.writeHead(200, {
          'content-type': MIME[extname(file)] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        })
        response.end(readFileSync(file))
      })
      const httpPort = await new Promise<number>((resolve) => {
        server?.listen(0, '127.0.0.1', () => {
          const address = server?.address()
          resolve(typeof address === 'object' && address ? address.port : 0)
        })
      })
      const debugPort = await freePort()
      chrome = spawn(
        CHROME!,
        [
          '--headless=new',
          '--no-sandbox',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          `--remote-debugging-port=${debugPort}`,
          `--user-data-dir=${userData}`,
          `http://127.0.0.1:${httpPort}/`,
        ],
        { stdio: 'ignore' },
      )
      const page = await waitForPage(debugPort)
      const dom = await pollDom(page.webSocketDebuggerUrl, 20_000)
      const lazyJs = hits.filter((hit) => hit.path.endsWith('.js') && !entryAssets.has(hit.path))
      const lazyCss = hits.filter((hit) => hit.path.endsWith('.css') && !entryAssets.has(hit.path))
      const documents = hits.filter((hit) => hit.path === '/' || hit.path === '/index.html')
      expect(
        { dom, documents: documents.length, lazyJs, lazyCss },
        JSON.stringify({ dom, hits }, null, 2),
      ).toMatchObject({
        dom: { text: 'canvas-ready', color: 'rgb(1, 2, 3)' },
      })
      expect(lazyJs.some((hit) => hit.status === 404)).toBe(true)
      expect(lazyJs.some((hit) => hit.status === 200)).toBe(true)
      expect(lazyCss.filter((hit) => hit.status === 404).length).toBeGreaterThan(0)
      expect(lazyCss.filter((hit) => hit.status === 200).length).toBeGreaterThan(0)
      // The stylesheet is refetched in place. Only the missing script spends the one reload.
      expect(documents.length).toBeLessThanOrEqual(2)
    } finally {
      chrome?.kill('SIGKILL')
      await delay(300)
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
      rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  60_000,
)

function freePort() {
  return new Promise<number>((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

async function waitForPage(port: number) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
        type?: string
        webSocketDebuggerUrl?: string
      }>
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page?.webSocketDebuggerUrl) return { webSocketDebuggerUrl: page.webSocketDebuggerUrl }
    } catch {
      // Chrome is still starting.
    }
    await delay(200)
  }
  throw new Error('Chrome did not expose a page target')
}

async function pollDom(webSocketUrl: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  let last = { text: '', color: '', href: '' }
  while (Date.now() < deadline) {
    try {
      last = await evaluate(webSocketUrl)
      if (last.text === 'canvas-ready' && last.color === 'rgb(1, 2, 3)') return last
    } catch {
      // The reload closes the page socket; the next poll opens the new one.
      const listed = await relist(webSocketUrl)
      if (listed) webSocketUrl = listed
    }
    await delay(250)
  }
  return last
}

async function relist(previous: string) {
  const port = new URL(previous).port
  try {
    const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
      type?: string
      webSocketDebuggerUrl?: string
    }>
    return pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      ?.webSocketDebuggerUrl
  } catch {
    return undefined
  }
}

async function evaluate(webSocketUrl: string) {
  const ws = new WebSocket(webSocketUrl)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('cdp socket failed')))
  })
  const result = await new Promise<string>((resolve, reject) => {
    const id = 1
    const timer = setTimeout(() => reject(new Error('cdp evaluate timed out')), 5_000)
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number
        result?: { result?: { value?: string } }
        error?: { message?: string }
      }
      if (message.id !== id) return
      clearTimeout(timer)
      if (message.error) reject(new Error(message.error.message ?? 'cdp error'))
      else resolve(message.result?.result?.value ?? '')
    })
    ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: {
          expression:
            "JSON.stringify({text:document.getElementById('root')?.textContent??'',color:document.getElementById('root')?getComputedStyle(document.getElementById('root')).color:'',href:location.href})",
          returnByValue: true,
        },
      }),
    )
  })
  ws.close()
  return JSON.parse(result) as { text: string; color: string; href: string }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

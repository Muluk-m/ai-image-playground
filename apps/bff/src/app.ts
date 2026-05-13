import { join, extname } from 'node:path'
import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import { config } from './config'
import { submitRoutes } from './routes/submit'
import { statusRoutes } from './routes/status'
import { resultRoutes } from './routes/result'
import { cancelRoutes } from './routes/cancel'
import { proxyRoutes } from './routes/proxy'

const corsOrigin = config.corsOrigins === '*' ? true : config.corsOrigins.split(',').map((s) => s.trim()).filter(Boolean)

const STATIC_DIR = config.staticDir

function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/v1/') || pathname.startsWith('/api-proxy/') || pathname === '/health'
}

/**
 * 给静态资源设 cache-control：
 * - hash 资源（vite contenthash 的 assets/*.js / *.css / *.webp 等）→ 1 年 immutable
 *   （文件名变化即 cache miss，安全）
 * - sw.js / index.html / manifest.webmanifest → no-cache（每次 revalidate，
 *   保证 deploy 后客户端立刻拿新版）
 * - 其它（图标、ico）→ no-cache 兜底
 */
function cacheControlFor(pathname: string): string {
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable'
  // sw.js 必须每次 deploy 后客户端立刻拿到最新版；CF Edge 对 .js 默认会边缘缓存，
  // no-cache 只是允许缓存但需要 revalidate。用 no-store 强制不缓存，叠加 private
  // 阻止任何共享 cache 持有副本。
  if (pathname === '/sw.js') return 'private, no-store, no-cache, must-revalidate, max-age=0'
  if (pathname === '/index.html' || pathname === '/manifest.webmanifest') return 'no-cache'
  return 'no-cache'
}

async function serveStatic(pathname: string): Promise<Response | null> {
  if (!STATIC_DIR) return null
  const file = Bun.file(join(STATIC_DIR, pathname))
  if (!(await file.exists())) return null
  return new Response(file, {
    headers: { 'cache-control': cacheControlFor(pathname) },
  })
}

const indexFile = STATIC_DIR ? Bun.file(join(STATIC_DIR, 'index.html')) : null
let indexExists: boolean | null = null

async function serveSpaFallback(): Promise<Response | null> {
  if (!indexFile) return null
  indexExists ??= await indexFile.exists()
  if (!indexExists) return null
  return new Response(Bun.file(indexFile.name!), {
    headers: { 'cache-control': 'no-cache' },
  })
}

export const app = new Elysia()
  .use(cors({ origin: corsOrigin }))
  .get('/health', () => ({ ok: true }))
  .use(submitRoutes)
  .use(statusRoutes)
  .use(resultRoutes)
  .use(cancelRoutes)
  .use(proxyRoutes)
  .onRequest(async ({ request, set }) => {
    const url = new URL(request.url)
    if (isApiPath(url.pathname)) return
    const res = await serveStatic(url.pathname)
    if (res) { set.headers = {}; return res }
  })
  .onError(async ({ request, set }) => {
    const url = new URL(request.url)
    if (isApiPath(url.pathname)) return
    if (!extname(url.pathname)) {
      const res = await serveSpaFallback()
      if (res) { set.status = 200; return res }
    }
  })

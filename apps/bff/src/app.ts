import { extname, join } from 'node:path'
import { cors } from '@elysiajs/cors'
import { Elysia } from 'elysia'
import { config } from './config'
import { userAuthRoutes } from './routes/auth'
import { cancelRoutes } from './routes/cancel'
import { channelsRoutes } from './routes/channels'
import { resultRoutes } from './routes/result'
import { statusRoutes } from './routes/status'
import { submitRoutes } from './routes/submit'

const corsOrigin =
  config.corsOrigins === '*'
    ? true
    : config.corsOrigins
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

const STATIC_DIR = config.staticDir

function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/v1/') || pathname.startsWith('/api/') || pathname === '/health'
}

/**
 * 给静态资源设 cache-control：
 * - hash 资源（vite contenthash 的 assets/*.js / *.css / *.webp 等）→ 1 年 immutable
 *   （文件名变化即 cache miss，安全）
 * - sw.js → no-store（每次 deploy 立刻 unregister）
 * - index.html / manifest.webmanifest → no-cache
 * - inspiration-manifest.json → public 短 max-age + stale-while-revalidate，
 *   让 CF Edge 边缘缓存，第二个用户首屏命中边缘
 * - 其它兜底 no-cache
 */
function cacheControlFor(pathname: string): string {
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable'
  if (pathname === '/sw.js') return 'private, no-store, no-cache, must-revalidate, max-age=0'
  if (pathname === '/index.html' || pathname === '/manifest.webmanifest') return 'no-cache'
  if (pathname === '/inspiration-manifest.json')
    return 'public, max-age=300, stale-while-revalidate=86400'
  return 'no-cache'
}

// gzip 候选：基于扩展名而非 content-type 判断（避免误压已压缩的 png/webp）
const COMPRESSIBLE_EXTS = new Set([
  '.html',
  '.js',
  '.css',
  '.json',
  '.svg',
  '.txt',
  '.webmanifest',
  '.map',
])
const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}
const GZIP_MIN_BYTES = 1024

async function serveStatic(pathname: string, request: Request): Promise<Response | null> {
  if (!STATIC_DIR) return null
  const file = Bun.file(join(STATIC_DIR, pathname))
  if (!(await file.exists())) return null

  const ext = extname(pathname).toLowerCase()
  const compressible = COMPRESSIBLE_EXTS.has(ext)
  const acceptEnc = (request.headers.get('accept-encoding') ?? '').toLowerCase()
  const wantsGzip = acceptEnc.includes('gzip')
  const size = file.size

  const baseHeaders: Record<string, string> = {
    'cache-control': cacheControlFor(pathname),
  }
  if (ext in MIME_BY_EXT) baseHeaders['content-type'] = MIME_BY_EXT[ext]!

  if (compressible && wantsGzip && size >= GZIP_MIN_BYTES) {
    const stream = file.stream().pipeThrough(new CompressionStream('gzip'))
    return new Response(stream, {
      headers: {
        ...baseHeaders,
        'content-encoding': 'gzip',
        vary: 'accept-encoding',
      },
    })
  }
  return new Response(file, { headers: baseHeaders })
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
  .use(cors({ origin: corsOrigin, credentials: true }))
  .get('/health', () => ({ ok: true }))
  .use(userAuthRoutes)
  .use(channelsRoutes)
  .use(submitRoutes)
  .use(statusRoutes)
  .use(resultRoutes)
  .use(cancelRoutes)
  .onRequest(async ({ request, set }) => {
    const url = new URL(request.url)
    if (isApiPath(url.pathname)) return
    const res = await serveStatic(url.pathname, request)
    if (res) {
      set.headers = {}
      return res
    }
  })
  .onError(async ({ request, set }) => {
    const url = new URL(request.url)
    if (isApiPath(url.pathname)) return
    if (!extname(url.pathname)) {
      const res = await serveSpaFallback()
      if (res) {
        set.status = 200
        return res
      }
    }
  })

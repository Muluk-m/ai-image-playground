import { hostname } from 'node:os'
import { extname, join } from 'node:path'
import { cors } from '@elysiajs/cors'
import { Elysia, StatusMap } from 'elysia'
import { config } from './config'
import { appVersion } from './lib/app-version'
import { isCapabilityEnabled } from './lib/capabilities'
import { assertPrivateBffOverlayPresent, loadPrivateBffOverlay } from './lib/private-overlay'
import { gzipBlob } from './lib/staticCompression'
import { createApiMetrics, isCountedPath } from './ops/api-metrics'
import { agentRoutes } from './routes/agent'
import { userAuthRoutes } from './routes/auth'
import { cancelRoutes } from './routes/cancel'
import { capabilitiesRoutes, internalCapabilitiesRoutes } from './routes/capabilities'
import { channelsRoutes } from './routes/channels'
import { domainHandoffRoutes } from './routes/domain-handoff'
import { generationRoutes } from './routes/generations'
import { internalInspirationRoutes, publicInspirationRoutes } from './routes/inspirations'
import { internalDrainRoutes } from './routes/internal-drain'
import { internalOpsRoutes } from './routes/internal-ops'
import { internalUserRoutes } from './routes/internal-users'
import { mediaRoutes } from './routes/media'
import { oauthRoutes } from './routes/oauth'
import { projectRoutes } from './routes/projects'
import { resultRoutes } from './routes/result'
import { statusRoutes } from './routes/status'
import { submitRoutes } from './routes/submit'
import { syncRoutes } from './routes/sync'

const corsOrigin = config.corsOrigins === '*' ? true : config.corsOriginList

const privateBffOverlay = await loadPrivateBffOverlay()
if (isCapabilityEnabled('billing:credits')) {
  assertPrivateBffOverlayPresent(privateBffOverlay, 'billing:credits')
}

const STATIC_DIR = config.staticDir

function isApiPath(pathname: string): boolean {
  return (
    pathname.startsWith('/v1/') ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/internal/') ||
    pathname === '/health'
  )
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
    return new Response(await gzipBlob(file), {
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

/** 运维看板的接口统计。按实例累计，由 `index.ts` 每分钟写库一次。 */
export const apiMetrics = createApiMetrics(hostname())
const requestStartedAt = new WeakMap<Request, number>()

/**
 * 路由直接返回 Response 时它自己带着状态码，`set.status` 仍是默认的 200；
 * `status(4xx, …)` 返回的对象把状态码放在 `code` 上。三处都看，才不会把错误数成成功。
 */
function responseStatus(value: unknown, status: number | string | undefined): number {
  if (value instanceof Response) return value.status
  if (value && typeof value === 'object' && 'code' in value) {
    const code = (value as { code: unknown }).code
    if (typeof code === 'number' && code >= 100 && code < 600) return code
  }
  if (typeof status === 'number') return status
  if (typeof status === 'string') return StatusMap[status as keyof typeof StatusMap] ?? 200
  return 200
}

export const app = new Elysia()
  .onRequest(({ request }) => {
    requestStartedAt.set(request, performance.now())
  })
  .onAfterResponse({ as: 'global' }, ({ request, route, set, responseValue }) => {
    const startedAt = requestStartedAt.get(request)
    if (startedAt === undefined) return
    const { pathname } = new URL(request.url)
    if (!isApiPath(pathname) || !isCountedPath(pathname)) return
    apiMetrics.record({
      at: Date.now(),
      route: `${request.method} ${route || '（未匹配的路径）'}`,
      status: responseStatus(responseValue, set.status),
      durationMs: performance.now() - startedAt,
    })
  })
  .use(cors({ origin: corsOrigin, credentials: true }))
  // `ok` is what the healthchecks and rollout read; `version` lets the deploy workflow confirm the
  // commit that is serving.
  .get('/health', () => ({ ok: true, version: appVersion() }))
  .use(userAuthRoutes)
  .use(domainHandoffRoutes)
  .use(oauthRoutes)
  .use(capabilitiesRoutes)
  .use(channelsRoutes)
  .use(submitRoutes)
  .use(statusRoutes)
  .use(resultRoutes)
  .use(cancelRoutes)
  .use(agentRoutes)
  .use(syncRoutes)
  .use(projectRoutes)
  .use(mediaRoutes)
  .use(publicInspirationRoutes)
  .use(generationRoutes)
  .use(internalUserRoutes)
  .use(internalOpsRoutes)
  .use(internalInspirationRoutes)
  .use(internalDrainRoutes)
  .use(internalCapabilitiesRoutes)
  .use(privateBffOverlay.routes)
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

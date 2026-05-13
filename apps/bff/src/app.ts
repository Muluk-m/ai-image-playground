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

async function serveStatic(path: string): Promise<Response | null> {
  if (!STATIC_DIR) return null
  const file = Bun.file(join(STATIC_DIR, path))
  if (await file.exists()) return new Response(file)
  return null
}

const indexFile = STATIC_DIR ? Bun.file(join(STATIC_DIR, 'index.html')) : null
let indexExists: boolean | null = null

async function serveSpaFallback(): Promise<Response | null> {
  if (!indexFile) return null
  indexExists ??= await indexFile.exists()
  if (!indexExists) return null
  return new Response(Bun.file(indexFile.name!))
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

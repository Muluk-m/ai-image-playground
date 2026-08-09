import { extname } from 'node:path'
import { cors } from '@elysiajs/cors'
import { Elysia } from 'elysia'
import { config } from './config'
import { authRoutes } from './routes/auth'
import { devicesRoutes } from './routes/devices'
import { imagesRoutes } from './routes/images'
import { overviewRoutes } from './routes/overview'
import { extensionRoutes, privateRoutes } from './routes/private'
import { tasksRoutes } from './routes/tasks'
import { usersRoutes } from './routes/users'
import { isApiPath, serveSpaFallback, serveStatic } from './static'

const corsOrigin =
  config.corsOrigins === '*'
    ? true
    : config.corsOrigins
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

const STATIC_DIR = config.staticDir

export const app = new Elysia()
  .use(cors({ origin: corsOrigin, credentials: true }))
  .get('/health', () => ({ ok: true }))
  .use(authRoutes)
  .use(devicesRoutes)
  .use(overviewRoutes)
  .use(tasksRoutes)
  .use(imagesRoutes)
  .use(extensionRoutes)
  .use(privateRoutes)
  .use(usersRoutes)
  // 静态托管：API 路由之后再 hook。/api/* 与 /health 跳过；其它路径先试静态文件，
  // 命中即返；未命中走 onError 的 SPA fallback（让 client-side router 接管）。
  // STATIC_DIR 为空（dev 模式，vite 自己跑前端）时整条链 no-op。
  .onRequest(async ({ request, set }) => {
    if (!STATIC_DIR) return
    const url = new URL(request.url)
    if (isApiPath(url.pathname)) return
    const res = await serveStatic(STATIC_DIR, url.pathname, request)
    if (res) {
      set.headers = {}
      return res
    }
  })
  .onError(async ({ request, set }) => {
    if (!STATIC_DIR) return
    const url = new URL(request.url)
    if (isApiPath(url.pathname)) return
    // 仅当 pathname 没扩展名时走 SPA fallback；防止 .png / .js 404 错误页变 html
    if (!extname(url.pathname)) {
      const res = await serveSpaFallback(STATIC_DIR)
      if (res) {
        set.status = 200
        return res
      }
    }
  })

import { cors } from '@elysiajs/cors'
import { Elysia } from 'elysia'
import { config } from './config'
import { authRoutes } from './routes/auth'
import { devicesRoutes } from './routes/devices'
import { tasksRoutes } from './routes/tasks'

const corsOrigin =
  config.corsOrigins === '*'
    ? true
    : config.corsOrigins
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

export const app = new Elysia()
  .use(cors({ origin: corsOrigin, credentials: true }))
  .get('/health', () => ({ ok: true }))
  .use(authRoutes)
  .use(devicesRoutes)
  .use(tasksRoutes)

import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import { config } from './config'
import { submitRoutes } from './routes/submit'
import { statusRoutes } from './routes/status'
import { resultRoutes } from './routes/result'
import { cancelRoutes } from './routes/cancel'

const corsOrigin = config.corsOrigins === '*' ? true : config.corsOrigins.split(',').map((s) => s.trim()).filter(Boolean)

export const app = new Elysia()
  .use(cors({ origin: corsOrigin }))
  .get('/health', () => ({ ok: true }))
  .use(submitRoutes)
  .use(statusRoutes)
  .use(resultRoutes)
  .use(cancelRoutes)

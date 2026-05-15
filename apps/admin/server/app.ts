import { cors } from '@elysiajs/cors'
import { Elysia } from 'elysia'
import { config } from './config'

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

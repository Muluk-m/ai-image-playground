import { Elysia } from 'elysia'
import { requireAuth } from '../lib/middleware'
import { buildOpsSnapshot } from '../lib/ops'

export const opsRoutes = new Elysia().use(requireAuth).get('/api/ops', () => buildOpsSnapshot())

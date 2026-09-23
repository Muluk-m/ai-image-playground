import { Elysia } from 'elysia'
import { parseOpsRange } from '../../contracts'
import { requireAuth } from '../lib/middleware'
import { buildOpsSnapshot } from '../lib/ops'

export const opsRoutes = new Elysia()
  .use(requireAuth)
  .get('/api/ops', ({ query }) =>
    buildOpsSnapshot(undefined, undefined, parseOpsRange(query.range)),
  )

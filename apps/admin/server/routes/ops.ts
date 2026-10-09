import { Elysia } from 'elysia'
import { parseOpsRange } from '../../contracts'
import { requireAuth } from '../lib/middleware'
import { buildOpsSnapshot } from '../lib/ops'
import { LogQueryError, parseLogQuery, readLogContext, readServerLogs } from '../lib/server-logs'

export const opsRoutes = new Elysia()
  .use(requireAuth)
  .get('/api/ops', ({ query }) =>
    buildOpsSnapshot(undefined, undefined, parseOpsRange(query.range)),
  )

  .get('/api/ops/logs', async ({ query, status }) => {
    try {
      return await readServerLogs(parseLogQuery(query))
    } catch (error) {
      if (error instanceof LogQueryError) return status(400, { error: error.message })
      console.error('[ops] server logs read failed', error)
      return status(503, { error: '日志暂时无法读取，请稍后刷新' })
    }
  })

  .get('/api/ops/logs/context', async ({ query, status }) => {
    try {
      return { entries: await readLogContext(query.id ?? '') }
    } catch (error) {
      if (error instanceof LogQueryError) return status(400, { error: error.message })
      return status(503, { error: '日志上下文暂时无法读取' })
    }
  })

import { Elysia } from 'elysia'
import { parseOpsRange } from '../../contracts'
import { requireAuth } from '../lib/middleware'
import { buildOpsSnapshot } from '../lib/ops'
import {
  LogQueryError,
  LogsUnavailableError,
  parseLogQuery,
  readLogContext,
  readServerLogs,
  readTaskTraces,
  readTrace,
} from '../lib/server-logs'

/** 没开 OpenObserve 的部署：给页面一个可识别的原因，不当成临时故障。 */
const OBSERVABILITY_OFF = 'observability_off'

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
      if (error instanceof LogsUnavailableError)
        return status(503, { error: error.message, code: OBSERVABILITY_OFF })
      console.error('[ops] server logs read failed', error)
      return status(503, { error: '日志暂时无法读取，请稍后刷新' })
    }
  })

  .get('/api/ops/logs/context', async ({ query, status }) => {
    try {
      return { entries: await readLogContext(query.id ?? '') }
    } catch (error) {
      if (error instanceof LogQueryError) return status(400, { error: error.message })
      if (error instanceof LogsUnavailableError)
        return status(503, { error: error.message, code: OBSERVABILITY_OFF })
      return status(503, { error: '日志上下文暂时无法读取' })
    }
  })

  .get('/api/ops/tasks/:taskId/traces', async ({ params, query, status }) => {
    try {
      return await readTaskTraces(params.taskId, Number(query.from), Number(query.to), {
        trees: query.trees === '1',
      })
    } catch (error) {
      if (error instanceof LogQueryError) return status(400, { error: error.message })
      if (error instanceof LogsUnavailableError)
        return status(503, { error: error.message, code: OBSERVABILITY_OFF })
      console.error('[ops] task traces read failed', error)
      return status(503, { error: '链路暂时无法读取' })
    }
  })

  .get('/api/ops/traces/:traceId', async ({ params, query, status }) => {
    try {
      return await readTrace(params.traceId, query.at === undefined ? undefined : Number(query.at))
    } catch (error) {
      if (error instanceof LogQueryError) return status(400, { error: error.message })
      if (error instanceof LogsUnavailableError)
        return status(503, { error: error.message, code: OBSERVABILITY_OFF })
      console.error('[ops] trace read failed', error)
      return status(503, { error: '链路暂时无法读取' })
    }
  })

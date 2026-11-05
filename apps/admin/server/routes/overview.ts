import { Elysia, t } from 'elysia'
import { parseRange, parseTimeWindow } from '../../contracts'
import { requireAuth } from '../lib/middleware'
import { getOverview } from '../lib/queries'
import { getTodayErrors, getTodayOverview } from '../lib/today'

export const overviewRoutes = new Elysia()
  .use(requireAuth)
  .get(
    '/api/overview',
    ({ query, status }) => {
      if (query.from !== undefined || query.to !== undefined) {
        const window = parseTimeWindow({ from: query.from, to: query.to })
        if (!window) return status(400, { error: '无效的概览时间范围' })
        return getOverview(parseRange(query.range), window)
      }
      return getOverview(parseRange(query.range))
    },
    {
      query: t.Object({
        range: t.Optional(t.String()),
        from: t.Optional(t.String()),
        to: t.Optional(t.String()),
      }),
    },
  )
  .get('/api/overview/today', () => getTodayOverview())
  .get('/api/overview/errors', () => getTodayErrors())

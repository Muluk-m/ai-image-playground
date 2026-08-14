import { Elysia, t } from 'elysia'
import { parseRange } from '../../contracts'
import { requireAuth } from '../lib/middleware'
import { getOverview } from '../lib/queries'

export const overviewRoutes = new Elysia().use(requireAuth).get(
  '/api/overview',
  ({ query }) => {
    const range = parseRange(query.range)
    return getOverview(range)
  },
  { query: t.Object({ range: t.Optional(t.String()) }) },
)

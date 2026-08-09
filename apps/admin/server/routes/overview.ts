import { Elysia, t } from 'elysia'
import { requireAuth } from '../lib/middleware'
import { getOverview, type Range } from '../lib/queries'

const VALID_RANGES: Range[] = ['1d', '7d', '30d']

export const overviewRoutes = new Elysia().use(requireAuth).get(
  '/api/overview',
  ({ query }) => {
    const range = (VALID_RANGES.includes(query.range as Range) ? query.range : '7d') as Range
    return getOverview(range)
  },
  { query: t.Object({ range: t.Optional(t.String()) }) },
)

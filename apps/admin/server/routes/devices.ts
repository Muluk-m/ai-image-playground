import { Elysia, t } from 'elysia'
import { requireAuth } from '../lib/middleware'
import { getDeviceDetail, listDevices, type Range, type SortKey } from '../lib/queries'

const VALID_RANGES: Range[] = ['1d', '7d', '30d']
const VALID_SORTS: SortKey[] = ['last_seen', 'today_count', 'total_count']

export const devicesRoutes = new Elysia()
  .use(requireAuth)
  .get(
    '/api/devices',
    async ({ query }) => {
      const range = (VALID_RANGES.includes(query.range as Range) ? query.range : '7d') as Range
      const sort = (
        VALID_SORTS.includes(query.sort as SortKey) ? query.sort : 'last_seen'
      ) as SortKey
      return await listDevices(range, sort)
    },
    {
      query: t.Object({
        range: t.Optional(t.String()),
        sort: t.Optional(t.String()),
      }),
    },
  )
  .get(
    '/api/devices/:id',
    async ({ params, query, set }) => {
      const range = (VALID_RANGES.includes(query.range as Range) ? query.range : '7d') as Range
      const detail = await getDeviceDetail(params.id, range)
      if (!detail.device) {
        set.status = 404
        return { error: 'device_not_found' }
      }
      return detail
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({ range: t.Optional(t.String()) }),
    },
  )

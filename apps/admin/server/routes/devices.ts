import { Elysia, t } from 'elysia'
import { parseRange, parseSort } from '../../contracts'
import { requireAuth } from '../lib/middleware'
import { getDeviceDetail, listDevices } from '../lib/queries'

export const devicesRoutes = new Elysia()
  .use(requireAuth)
  .get(
    '/api/devices',
    async ({ query }) => {
      const range = parseRange(query.range)
      const sort = parseSort(query.sort)
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
      const range = parseRange(query.range)
      const cursor = typeof query.cursor === 'string' && query.cursor ? query.cursor : undefined
      const detail = await getDeviceDetail(params.id, range, cursor)
      // 404 只在首页判定（首页无 cursor 时才查设备聚合）。翻页请求 device 恒为 null，
      // 不能据此 404——否则第二页起永远 404。
      if (!cursor && !detail.device) {
        set.status = 404
        return { error: 'device_not_found' }
      }
      return detail
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({ range: t.Optional(t.String()), cursor: t.Optional(t.String()) }),
    },
  )

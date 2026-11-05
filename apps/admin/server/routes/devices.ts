import { Elysia, t } from 'elysia'
import { parseRange, parseSort, parseTimeWindow } from '../../contracts'
import { requireAuth } from '../lib/middleware'
import { getDeviceDetail, listDevices } from '../lib/queries'

export const devicesRoutes = new Elysia()
  .use(requireAuth)
  .get(
    '/api/devices',
    async ({ query, status }) => {
      const range = parseRange(query.range)
      const sort = parseSort(query.sort)
      const window =
        query.from !== undefined || query.to !== undefined ? parseTimeWindow(query) : undefined
      if ((query.from !== undefined || query.to !== undefined) && !window)
        return status(400, { error: '无效的设备时间范围' })
      const page = query.page === undefined ? undefined : Number(query.page)
      const pageSize = query.pageSize === undefined ? undefined : Number(query.pageSize)
      if (
        (query.page !== undefined && (!Number.isInteger(page) || page! < 1)) ||
        (query.pageSize !== undefined && pageSize !== 50 && pageSize !== 100)
      )
        return status(400, { error: '无效的分页' })
      return await listDevices(range, sort, {
        q: query.q?.trim() || undefined,
        page,
        pageSize: pageSize === 100 ? 100 : pageSize === 50 ? 50 : undefined,
        from: window?.from,
        to: window?.to,
      })
    },
    {
      query: t.Object({
        range: t.Optional(t.String()),
        sort: t.Optional(t.String()),
        q: t.Optional(t.String({ maxLength: 128 })),
        from: t.Optional(t.String()),
        to: t.Optional(t.String()),
        page: t.Optional(t.String()),
        pageSize: t.Optional(t.String()),
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

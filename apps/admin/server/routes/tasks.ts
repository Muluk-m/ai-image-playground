import { Elysia, t } from 'elysia'
import { parseGenerationTaskFilters, parseTimeWindow } from '../../contracts'
import { forwardInternalBff } from '../lib/internal-bff'
import { requireAuth } from '../lib/middleware'
import { getTask } from '../lib/queries'
import { forwardTaskReconciliation } from '../lib/task-reconciliation'
import {
  exportGenerationTasks,
  generationTasksCsv,
  getGenerationTasks,
  TaskQueryError,
} from '../lib/today'

export const tasksRoutes = new Elysia()
  .use(requireAuth)
  .get(
    '/api/tasks',
    async ({ query, status }) => {
      const filters = parseGenerationTaskFilters(query)
      if ((query.from !== undefined || query.to !== undefined) && !parseTimeWindow(query))
        return status(400, { error: '无效的任务时间范围' })
      for (const key of [
        'userId',
        'deviceId',
        'unassigned',
        'status',
        'model',
        'source',
      ] as const) {
        if (query[key] !== undefined && query[key] !== filters[key])
          return status(400, { error: '无效的任务筛选条件' })
      }
      if (query.q !== undefined && query.q !== '' && query.q !== filters.q)
        return status(400, { error: '无效的任务筛选条件' })
      for (const key of ['models', 'providers', 'errorTypes'] as const) {
        if (query[key] !== undefined && query[key] !== '' && filters[key]?.join(',') !== query[key])
          return status(400, { error: '无效的任务筛选条件' })
      }
      if (
        query.minDurationSec !== undefined &&
        query.minDurationSec !== '' &&
        String(filters.minDurationSec ?? '') !== query.minDurationSec
      )
        return status(400, { error: '无效的任务筛选条件' })
      if (
        query.page !== undefined &&
        query.page !== '' &&
        String(filters.page ?? '') !== query.page
      )
        return status(400, { error: '无效的任务筛选条件' })
      if (
        query.pageSize !== undefined &&
        query.pageSize !== '' &&
        String(filters.pageSize ?? '') !== query.pageSize
      )
        return status(400, { error: '无效的任务筛选条件' })
      if ([filters.userId, filters.deviceId, filters.unassigned].filter(Boolean).length > 1)
        return status(400, { error: '只能选择一种任务归属' })
      try {
        return await getGenerationTasks(filters, query.cursor)
      } catch (error) {
        if (error instanceof TaskQueryError) return status(400, { error: error.message })
        throw error
      }
    },
    {
      query: t.Object({
        from: t.Optional(t.String()),
        to: t.Optional(t.String()),
        userId: t.Optional(t.String()),
        deviceId: t.Optional(t.String()),
        unassigned: t.Optional(t.String()),
        status: t.Optional(t.String()),
        model: t.Optional(t.String()),
        models: t.Optional(t.String()),
        providers: t.Optional(t.String()),
        errorTypes: t.Optional(t.String()),
        minDurationSec: t.Optional(t.String()),
        q: t.Optional(t.String()),
        source: t.Optional(t.String()),
        page: t.Optional(t.String()),
        pageSize: t.Optional(t.String()),
        cursor: t.Optional(t.String({ maxLength: 300 })),
      }),
    },
  )
  .get(
    '/api/tasks/export',
    async ({ admin, query, status }) => {
      const filters = parseGenerationTaskFilters(query)
      if ((query.from !== undefined || query.to !== undefined) && !parseTimeWindow(query))
        return status(400, { error: '无效的任务时间范围' })
      const exported = await exportGenerationTasks(filters)
      const recorded = await forwardInternalBff({
        method: 'POST',
        path: '/internal/admin/audits',
        operator: admin.operatorId,
        body: {
          action: 'tasks.export',
          targetType: 'generation_tasks',
          targetId: 'export',
          details: {
            filters,
            rowCount: exported.tasks.length,
            truncated: exported.truncated,
            window: exported.window,
          },
        },
      })
      if (!recorded.ok) return status(502, { error: '导出审计写入失败' })
      return new Response(generationTasksCsv(exported.tasks), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="generation-tasks.csv"',
        },
      })
    },
    {
      query: t.Object({
        from: t.Optional(t.String()),
        to: t.Optional(t.String()),
        userId: t.Optional(t.String()),
        deviceId: t.Optional(t.String()),
        unassigned: t.Optional(t.String()),
        status: t.Optional(t.String()),
        model: t.Optional(t.String()),
        models: t.Optional(t.String()),
        providers: t.Optional(t.String()),
        errorTypes: t.Optional(t.String()),
        minDurationSec: t.Optional(t.String()),
        q: t.Optional(t.String()),
        source: t.Optional(t.String()),
      }),
    },
  )
  .get(
    '/api/tasks/:id',
    async ({ params, set }) => {
      const task = await getTask(params.id)
      if (!task) {
        set.status = 404
        return { error: 'task_not_found' }
      }
      return task
    },
    { params: t.Object({ id: t.String() }) },
  )

  .get('/api/tasks/:id/reconciliation', ({ params }) => forwardTaskReconciliation(params.id), {
    params: t.Object({ id: t.String({ minLength: 1 }) }),
  })
  .post(
    '/api/tasks/:id/reconciliation',
    ({ params, body, admin }) =>
      forwardTaskReconciliation(params.id, { ...body, operatorId: admin.operatorId }),
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      body: t.Object({
        commandId: t.String({ minLength: 1, maxLength: 128 }),
        evidence: t.String({ minLength: 1, maxLength: 4000 }),
        action: t.Union([
          t.Literal('lookup'),
          t.Literal('confirm_success'),
          t.Literal('confirm_no_result'),
        ]),
        result: t.Optional(t.Record(t.String(), t.Unknown())),
      }),
    },
  )

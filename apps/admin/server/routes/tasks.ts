import { Elysia, t } from 'elysia'
import { parseGenerationTaskFilters, parseTimeWindow } from '../../contracts'
import { requireAuth } from '../lib/middleware'
import { getTask } from '../lib/queries'
import { forwardTaskReconciliation } from '../lib/task-reconciliation'
import { getGenerationTasks, TaskQueryError } from '../lib/today'

export const tasksRoutes = new Elysia()
  .use(requireAuth)
  .get(
    '/api/tasks',
    async ({ query, status }) => {
      const filters = parseGenerationTaskFilters(query)
      if ((query.from !== undefined || query.to !== undefined) && !parseTimeWindow(query))
        return status(400, { error: '无效的任务时间范围' })
      for (const key of ['userId', 'deviceId', 'unassigned', 'status'] as const) {
        if (query[key] !== undefined && query[key] !== filters[key])
          return status(400, { error: '无效的任务筛选条件' })
      }
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
        cursor: t.Optional(t.String({ maxLength: 300 })),
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

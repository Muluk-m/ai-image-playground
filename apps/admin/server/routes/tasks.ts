import { Elysia, t } from 'elysia'
import { requireAuth } from '../lib/middleware'
import { getTask } from '../lib/queries'
import { forwardTaskReconciliation } from '../lib/task-reconciliation'

export const tasksRoutes = new Elysia()
  .use(requireAuth)
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

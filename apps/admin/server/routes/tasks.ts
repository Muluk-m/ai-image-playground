import { Elysia, t } from 'elysia'
import { requireAuth } from '../lib/middleware'
import { getTask } from '../lib/queries'

export const tasksRoutes = new Elysia().use(requireAuth).get(
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

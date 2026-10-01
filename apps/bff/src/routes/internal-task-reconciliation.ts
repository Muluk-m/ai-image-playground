import { Elysia, t } from 'elysia'
import { readAnalysisReconciliation, reconcileAnalysisTask } from '../lib/analysis-reconciliation'
import {
  ReconciliationError,
  readTaskReconciliation,
  reconcileTask,
} from '../lib/task-reconciliation'
import { requireInternalService } from '../lib/user-auth'

export const internalTaskReconciliationRoutes = new Elysia({ prefix: '/internal/admin/tasks' })
  .use(requireInternalService)
  .onError(({ error, status }) => {
    if (error instanceof ReconciliationError) return status(error.httpStatus, { error: error.code })
  })
  .get(
    '/:id/reconciliation',
    async ({ params }) =>
      (await readAnalysisReconciliation(params.id)) ?? readTaskReconciliation(params.id),
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
    },
  )
  .post(
    '/:id/reconciliation',
    async ({ params, body }) =>
      (await readAnalysisReconciliation(params.id))
        ? reconcileAnalysisTask(params.id, body)
        : reconcileTask(params.id, body),
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      body: t.Object({
        commandId: t.String({ minLength: 1, maxLength: 128 }),
        operatorId: t.String({ minLength: 1, maxLength: 256 }),
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

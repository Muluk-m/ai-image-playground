import { Elysia, t } from 'elysia'
import { OperatorAuditError, recordOperatorAudit } from '../lib/operator-audit'
import { requireInternalService } from '../lib/user-auth'

export const internalAuditRoutes = new Elysia({ prefix: '/internal/admin/audits' })
  .use(requireInternalService)
  .post(
    '/',
    async ({ body, request, status }) => {
      try {
        await recordOperatorAudit({
          operatorId: request.headers.get('x-admin-operator') || body.operatorId,
          action: body.action,
          targetType: body.targetType,
          targetId: body.targetId,
          details: body.details,
        })
        return { ok: true as const }
      } catch (error) {
        if (error instanceof OperatorAuditError) return status(400, { error: error.message })
        throw error
      }
    },
    {
      body: t.Object({
        action: t.String({ minLength: 1, maxLength: 64 }),
        targetType: t.String({ minLength: 1, maxLength: 64 }),
        targetId: t.String({ minLength: 1, maxLength: 128 }),
        operatorId: t.Optional(t.String({ minLength: 1, maxLength: 320 })),
        details: t.Record(t.String(), t.Unknown()),
      }),
    },
  )

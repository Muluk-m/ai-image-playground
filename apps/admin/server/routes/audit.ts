import { Elysia, t } from 'elysia'
import { requireAuth } from '../lib/middleware'
import { listOperatorAudits } from '../lib/queries'

// 审计是只读的：写入全部发生在 BFF 的事务里（apps/bff/src/lib/user-admin.ts、lib/inspirations.ts），
// 后台这边连 SELECT 权限都只有这一张表的读。
export const auditRoutes = new Elysia({ prefix: '/api' }).use(requireAuth).get(
  '/audits',
  ({ query }) =>
    listOperatorAudits({
      cursor: query.cursor || undefined,
      limit: query.limit,
      action: query.action || undefined,
      settingKey: query.settingKey || undefined,
      targetId: query.targetId || undefined,
      operatorId: query.operatorId || undefined,
      from: query.from,
      to: query.to,
    }),
  {
    query: t.Object({
      cursor: t.Optional(t.String({ maxLength: 256 })),
      limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1 })),
      action: t.Optional(t.String({ maxLength: 64 })),
      settingKey: t.Optional(t.String({ maxLength: 128 })),
      targetId: t.Optional(t.String({ maxLength: 256 })),
      operatorId: t.Optional(t.String({ maxLength: 320 })),
      from: t.Optional(t.Numeric()),
      to: t.Optional(t.Numeric()),
    }),
  },
)

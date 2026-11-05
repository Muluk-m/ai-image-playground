import { Elysia, t } from 'elysia'
import { directKeyPanel, restoreDirectKey } from '../lib/upstream/gpt-keys'
import { requireInternalService } from '../lib/user-auth'

function daysOf(value: string | undefined): 7 | 30 {
  return value === '30' ? 30 : 7
}

export const internalGptDirectRoutes = new Elysia({ prefix: '/internal/admin/gpt-direct' })
  .use(requireInternalService)
  .get('/', ({ query }) => directKeyPanel(daysOf(query.days)), {
    query: t.Object({ days: t.Optional(t.String()) }),
  })
  .post('/keys/:fingerprint/restore', async ({ params, request, status }) => {
    if (!/^[0-9a-f]{8}$/.test(params.fingerprint)) return status(400, { error: 'bad_fingerprint' })
    const operator = request.headers.get('x-admin-operator')?.trim() || undefined
    const restored = await restoreDirectKey(params.fingerprint, operator)
    if (!restored) return status(404, { error: 'unknown_key' })
    return { ok: true as const }
  })

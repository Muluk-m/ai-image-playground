import { Elysia, t } from 'elysia'
import {
  createGeminiDirectKey,
  deleteGeminiDirectKey,
  reorderGeminiDirectKeys,
  updateGeminiDirectKey,
} from '../lib/upstream/gemini-direct-admin'
import {
  geminiDirectPanel,
  restoreGeminiDirectKeyAfterSync,
} from '../lib/upstream/gemini-direct-panel'
import { UpstreamSecretError } from '../lib/upstream-secrets'
import { requireInternalService } from '../lib/user-auth'

function daysOf(value: string | undefined): 7 | 30 {
  return value === '30' ? 30 : 7
}

export const internalGeminiDirectRoutes = new Elysia({ prefix: '/internal/admin/gemini-direct' })
  .use(requireInternalService)
  .onError({ as: 'scoped' }, ({ code, error, set }) => {
    if (code === 'VALIDATION') {
      // 绝不回显请求体中的原始 value（可能包含明文 apiKey）。
      set.status = 400
      return { error: 'invalid_request', message: '请求参数无效' }
    }
    if (error instanceof UpstreamSecretError) {
      set.status = error.status
      return { error: error.code, message: error.message }
    }
  })
  .get('/', ({ query }) => geminiDirectPanel(daysOf(query.days)), {
    query: t.Object({ days: t.Optional(t.String()) }),
  })
  .post(
    '/keys',
    async ({ body, request }) => {
      await createGeminiDirectKey({
        apiKey: body.apiKey,
        budgetUsd: body.budgetUsd,
        operatorId: request.headers.get('x-admin-operator'),
      })
      return geminiDirectPanel(7)
    },
    { body: t.Object({ apiKey: t.String(), budgetUsd: t.Numeric() }) },
  )
  .post(
    '/keys/order',
    async ({ body, request }) => {
      await reorderGeminiDirectKeys({
        ids: body.ids,
        revision: body.revision,
        operatorId: request.headers.get('x-admin-operator'),
      })
      return geminiDirectPanel(7)
    },
    { body: t.Object({ ids: t.Array(t.String()), revision: t.Numeric() }) },
  )
  .patch(
    '/keys/:id',
    async ({ body, params, request }) => {
      await updateGeminiDirectKey({
        id: params.id,
        ...(body.budgetUsd !== undefined ? { budgetUsd: body.budgetUsd } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        operatorId: request.headers.get('x-admin-operator'),
      })
      return geminiDirectPanel(7)
    },
    {
      body: t.Object({
        budgetUsd: t.Optional(t.Numeric()),
        enabled: t.Optional(t.Boolean()),
      }),
    },
  )
  .delete('/keys/:id', async ({ params, request }) => {
    await deleteGeminiDirectKey({
      id: params.id,
      operatorId: request.headers.get('x-admin-operator'),
    })
    return geminiDirectPanel(7)
  })
  .post('/keys/:fingerprint/restore', async ({ params, request, status }) => {
    if (!/^(?:[0-9a-f]{8}|legacy)$/.test(params.fingerprint)) {
      return status(400, { error: 'bad_fingerprint' })
    }
    const operator = request.headers.get('x-admin-operator')?.trim() || undefined
    const restored = await restoreGeminiDirectKeyAfterSync(params.fingerprint, operator)
    if (!restored) return status(404, { error: 'unknown_key' })
    return geminiDirectPanel(7)
  })

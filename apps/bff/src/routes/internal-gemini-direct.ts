import { Elysia, t } from 'elysia'
import {
  createGeminiDirectKey,
  deleteGeminiDirectKey,
  reorderGeminiDirectKeys,
  updateGeminiDirectKey,
} from '../lib/upstream/gemini-direct-admin'
import { buildGeminiDirectKeyPanel, restoreGeminiDirectKey } from '../lib/upstream/gemini-keys'
import { UpstreamSecretError } from '../lib/upstream-secrets'
import { requireInternalService } from '../lib/user-auth'

function daysOf(value: string | undefined): 7 | 30 {
  return value === '30' ? 30 : 7
}

function reject(error: unknown, status: (code: number, body: unknown) => unknown) {
  if (error instanceof UpstreamSecretError) {
    return status(error.status, { error: error.code, message: error.message })
  }
  throw error
}

export const internalGeminiDirectRoutes = new Elysia({ prefix: '/internal/admin/gemini-direct' })
  .use(requireInternalService)
  .get('/', ({ query }) => buildGeminiDirectKeyPanel(daysOf(query.days)), {
    query: t.Object({ days: t.Optional(t.String()) }),
  })
  .post(
    '/keys',
    async ({ body, request, status }) => {
      try {
        await createGeminiDirectKey({
          apiKey: body.apiKey,
          budgetUsd: body.budgetUsd,
          operatorId: request.headers.get('x-admin-operator'),
        })
        return buildGeminiDirectKeyPanel(7)
      } catch (error) {
        return reject(error, status)
      }
    },
    { body: t.Object({ apiKey: t.String(), budgetUsd: t.Numeric() }) },
  )
  .post(
    '/keys/order',
    async ({ body, request, status }) => {
      try {
        await reorderGeminiDirectKeys({
          ids: body.ids,
          revision: body.revision,
          operatorId: request.headers.get('x-admin-operator'),
        })
        return buildGeminiDirectKeyPanel(7)
      } catch (error) {
        return reject(error, status)
      }
    },
    { body: t.Object({ ids: t.Array(t.String()), revision: t.Numeric() }) },
  )
  .patch(
    '/keys/:id',
    async ({ body, params, request, status }) => {
      try {
        await updateGeminiDirectKey({
          id: params.id,
          ...(body.budgetUsd !== undefined ? { budgetUsd: body.budgetUsd } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          operatorId: request.headers.get('x-admin-operator'),
        })
        return buildGeminiDirectKeyPanel(7)
      } catch (error) {
        return reject(error, status)
      }
    },
    {
      body: t.Object({
        budgetUsd: t.Optional(t.Numeric()),
        enabled: t.Optional(t.Boolean()),
      }),
    },
  )
  .delete('/keys/:id', async ({ params, request, status }) => {
    try {
      await deleteGeminiDirectKey({
        id: params.id,
        operatorId: request.headers.get('x-admin-operator'),
      })
      return buildGeminiDirectKeyPanel(7)
    } catch (error) {
      return reject(error, status)
    }
  })
  .post('/keys/:fingerprint/restore', async ({ params, request, status }) => {
    if (!/^(?:[0-9a-f]{8}|legacy)$/.test(params.fingerprint)) {
      return status(400, { error: 'bad_fingerprint' })
    }
    const operator = request.headers.get('x-admin-operator')?.trim() || undefined
    const restored = await restoreGeminiDirectKey(params.fingerprint, operator)
    if (!restored) return status(404, { error: 'unknown_key' })
    return buildGeminiDirectKeyPanel(7)
  })

import { Elysia, t } from 'elysia'
import {
  createGptDirectKey,
  deleteGptDirectKey,
  reorderGptDirectKeys,
  updateGptDirectKey,
} from '../lib/upstream/gpt-direct-admin'
import { directKeyPanel, restoreDirectKey } from '../lib/upstream/gpt-keys'
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

export const internalGptDirectRoutes = new Elysia({ prefix: '/internal/admin/gpt-direct' })
  .use(requireInternalService)
  .get('/', ({ query }) => directKeyPanel(daysOf(query.days)), {
    query: t.Object({ days: t.Optional(t.String()) }),
  })
  .post(
    '/keys',
    async ({ body, request, status }) => {
      try {
        await createGptDirectKey({
          apiKey: body.apiKey,
          budgetUsd: body.budgetUsd,
          operatorId: request.headers.get('x-admin-operator'),
        })
        return directKeyPanel(7)
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
        await reorderGptDirectKeys({
          ids: body.ids,
          revision: body.revision,
          operatorId: request.headers.get('x-admin-operator'),
        })
        return directKeyPanel(7)
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
        await updateGptDirectKey({
          id: params.id,
          ...(body.budgetUsd !== undefined ? { budgetUsd: body.budgetUsd } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          operatorId: request.headers.get('x-admin-operator'),
        })
        return directKeyPanel(7)
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
      await deleteGptDirectKey({
        id: params.id,
        operatorId: request.headers.get('x-admin-operator'),
      })
      return directKeyPanel(7)
    } catch (error) {
      return reject(error, status)
    }
  })
  .post('/keys/:fingerprint/restore', async ({ params, request, status }) => {
    // 'legacy'：没配指纹密钥、只有一把环境变量 key 时的占位指纹，见 gpt-key-config 的 legacySingleKey。
    if (!/^(?:[0-9a-f]{8}|legacy)$/.test(params.fingerprint))
      return status(400, { error: 'bad_fingerprint' })
    const operator = request.headers.get('x-admin-operator')?.trim() || undefined
    const restored = await restoreDirectKey(params.fingerprint, operator)
    if (!restored) return status(404, { error: 'unknown_key' })
    return directKeyPanel(7)
  })

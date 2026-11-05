import { Elysia, t } from 'elysia'
import {
  clearUpstreamSecret,
  listUpstreamSecrets,
  replaceUpstreamSecret,
  testUpstreamSecret,
  UpstreamSecretError,
} from '../lib/upstream-secrets'
import { requireInternalService } from '../lib/user-auth'

const id = t.String({ minLength: 1, maxLength: 64 })
const secretBody = t.Object({ apiKey: t.Any() })

function operatorId(request: Request): string | null {
  return request.headers.get('x-admin-operator')
}

export const internalUpstreamSecretRoutes = new Elysia({
  prefix: '/internal/admin/upstream-secrets',
})
  .use(requireInternalService)
  .onError({ as: 'scoped' }, ({ code, error, set }) => {
    if (code === 'VALIDATION') {
      set.status = 400
      return { error: 'invalid_secret' }
    }
    if (error instanceof UpstreamSecretError) {
      set.status = error.status
      return { error: error.code, message: error.message }
    }
  })
  .get('/', () => listUpstreamSecrets())
  .put(
    '/:id',
    ({ params, body, request }) =>
      replaceUpstreamSecret({
        slotId: params.id,
        apiKey: body.apiKey,
        operatorId: operatorId(request),
      }),
    {
      params: t.Object({ id }),
      body: secretBody,
    },
  )
  .delete(
    '/:id',
    ({ params, request }) =>
      clearUpstreamSecret({ slotId: params.id, operatorId: operatorId(request) }),
    { params: t.Object({ id }) },
  )
  .post('/:id/test', ({ params, body }) => testUpstreamSecret(params.id, body.apiKey), {
    params: t.Object({ id }),
    body: secretBody,
  })

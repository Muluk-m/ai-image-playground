import { Elysia, t } from 'elysia'
import {
  confirmStageAuthorization,
  endStageAuthorization,
  preflightStageAuthorization,
  readStageAuthorization,
  StageAuthorizationError,
} from '../lib/agent/stage-authorizations'
import { isCapabilityEnabled } from '../lib/capabilities'
import { resolveAuthUser } from '../lib/user-auth'

const params = t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) })
export const stageAuthorizationRoutes = new Elysia({ name: 'agent-stage-authorizations' })
  .use(resolveAuthUser)
  .onBeforeHandle(({ authUser, status }) => {
    if (!authUser) return status(401, { error: 'unauthorized' })
    if (!isCapabilityEnabled('accounts:sync'))
      return status(403, { error: 'canvas_sync_unavailable' })
  })
  .onError(({ error, set }) => {
    if (error instanceof StageAuthorizationError) {
      set.status = error.status
      return { error: error.code }
    }
  })
  .get(
    '/api/agent/stage-authorizations/:id',
    ({ authUser, params }) => readStageAuthorization(authUser!.id, params.id),
    { params },
  )
  .post(
    '/api/agent/stage-authorizations/:id/confirm',
    ({ authUser, params, body }) =>
      confirmStageAuthorization(authUser!.id, params.id, body.charges),
    {
      params,
      body: t.Object({
        charges: t.Optional(
          t.Array(
            t.Object({
              nodeId: t.String({ minLength: 1, maxLength: 128 }),
              model: t.String({ minLength: 1, maxLength: 128 }),
              quantity: t.Number({ exclusiveMinimum: 0, maximum: 10000 }),
              unitMultiplier: t.Number({ exclusiveMinimum: 0, maximum: 10000 }),
            }),
            { maxItems: 200 },
          ),
        ),
      }),
    },
  )
  .post(
    '/api/agent/stage-authorizations/:id/end',
    ({ authUser, params }) => endStageAuthorization(authUser!.id, params.id),
    { params, body: t.Object({}) },
  )
  .post(
    '/api/agent/stage-authorizations/:id/preflight',
    ({ authUser, params, body }) => preflightStageAuthorization(authUser!.id, params.id, body),
    {
      params,
      body: t.Object({
        nodeId: t.String({ minLength: 1, maxLength: 128 }),
        attemptId: t.String({ minLength: 1, maxLength: 128 }),
        executionToken: t.String({ minLength: 1, maxLength: 128 }),
        model: t.String({ minLength: 1, maxLength: 128 }),
        quantity: t.Number({ exclusiveMinimum: 0, maximum: 10000 }),
        unitMultiplier: t.Number({ exclusiveMinimum: 0, maximum: 10000 }),
      }),
    },
  )

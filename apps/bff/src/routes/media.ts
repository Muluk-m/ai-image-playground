import { Elysia, t } from 'elysia'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { accessMedia, completeMedia, MediaError, reserveMedia } from '../lib/projectMedia'
import { resolveAuthUser } from '../lib/user-auth'

async function respond(work: () => Promise<unknown>) {
  try {
    return await work()
  } catch (error) {
    if (error instanceof MediaError)
      return Response.json({ error: error.message }, { status: error.status })
    throw error
  }
}

const params = t.Object({ id: t.String({ format: 'uuid' }) })
export const mediaRoutes = new Elysia()
  .onError({ as: 'scoped' }, ({ error, set }) => {
    if (error instanceof MediaError) {
      set.status = error.status
      return { error: error.message }
    }
  })
  .use(resolveAuthUser)
  .onBeforeHandle(({ set }) => {
    set.headers['cache-control'] = 'private, no-store'
    if (!isCapabilityEnabled('accounts:sync')) return capabilityUnavailable('accounts:sync')
  })
  .post(
    '/api/media/uploads',
    ({ authUser, body, status }) =>
      authUser
        ? respond(() => reserveMedia(authUser.id, body))
        : status(401, { error: 'unauthorized' }),
    {
      body: t.Object(
        {
          sha256: t.String({ pattern: '^[a-f0-9]{64}$' }),
          bytes: t.Integer({ minimum: 1, maximum: 100_000_000 }),
          contentType: t.String({ pattern: '^image/(png|jpeg|webp)$' }),
        },
        { additionalProperties: false },
      ),
    },
  )
  .post(
    '/api/media/:id/complete',
    ({ authUser, params, status }) =>
      authUser
        ? respond(() => completeMedia(authUser.id, params.id))
        : status(401, { error: 'unauthorized' }),
    { params },
  )
  .get(
    '/api/media/:id/access',
    ({ authUser, params, status }) =>
      authUser
        ? respond(() => accessMedia(authUser.id, params.id))
        : status(401, { error: 'unauthorized' }),
    { params },
  )

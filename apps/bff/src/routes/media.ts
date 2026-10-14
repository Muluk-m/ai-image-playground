import { Elysia, t } from 'elysia'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { log } from '../lib/logger'
import { accessMedia, completeMedia, MediaError, reserveMedia } from '../lib/projectMedia'
import { promoteQueueVideo, serveMediaContent } from '../lib/projectVideoMedia'
import { resolveAuthUser } from '../lib/user-auth'

async function respond(
  work: () => Promise<unknown>,
  context: {
    userId: string
    mediaId?: string
    stage: 'reserve' | 'complete' | 'access' | 'promote' | 'content'
  },
) {
  try {
    return await work()
  } catch (error) {
    if (error instanceof MediaError) {
      log.warn(
        {
          event: 'media.request_rejected',
          ...context,
          errorCode: error.message,
          reason: error.reason,
          status: error.status,
        },
        'media request rejected',
      )
      return Response.json({ error: error.message }, { status: error.status })
    }
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
        ? respond(() => reserveMedia(authUser.id, body), { userId: authUser.id, stage: 'reserve' })
        : status(401, { error: 'unauthorized' }),
    {
      body: t.Object(
        {
          purpose: t.Optional(t.Literal('conversation-attachment')),
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
        ? respond(() => completeMedia(authUser.id, params.id), {
            userId: authUser.id,
            mediaId: params.id,
            stage: 'complete',
          })
        : status(401, { error: 'unauthorized' }),
    { params },
  )
  .get(
    '/api/media/:id/access',
    ({ authUser, params, status }) =>
      authUser
        ? respond(() => accessMedia(authUser.id, params.id), {
            userId: authUser.id,
            mediaId: params.id,
            stage: 'access',
          })
        : status(401, { error: 'unauthorized' }),
    { params },
  )

  .post(
    '/api/media/video-outputs',
    ({ authUser, body, status }) =>
      authUser
        ? respond(() => promoteQueueVideo(authUser.id, body.taskId, body.outputIndex), {
            userId: authUser.id,
            stage: 'promote',
          })
        : status(401, { error: 'unauthorized' }),
    {
      body: t.Object(
        {
          taskId: t.String({ pattern: '^[A-Za-z0-9_-]{1,128}$' }),
          outputIndex: t.Integer({ minimum: 0, maximum: 15 }),
        },
        { additionalProperties: false },
      ),
    },
  )
  .get(
    '/api/media/:id/content',
    ({ authUser, params, request, status }) =>
      authUser
        ? respond(() => serveMediaContent(authUser.id, params.id, request), {
            userId: authUser.id,
            mediaId: params.id,
            stage: 'content',
          })
        : status(401, { error: 'unauthorized' }),
    { params },
  )

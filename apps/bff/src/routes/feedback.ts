import { FEEDBACK_MESSAGE_MAX_CHARS } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { config } from '../config'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import {
  FeedbackError,
  getAdminFeedbackThread,
  getUserFeedbackSummary,
  getUserFeedbackThread,
  listAdminFeedbackThreads,
  markUserFeedbackRead,
  postUserFeedbackMessage,
  readFeedbackAttachment,
  readFeedbackUpload,
  replyAdminFeedbackThread,
  updateAdminFeedbackThreadStatus,
} from '../lib/feedback'
import { createWindowLimiter } from '../lib/rate-limit'
import { requireInternalService, resolveAuthUser } from '../lib/user-auth'

const messageLimiter = createWindowLimiter(10 * 60_000, 2048)

function operatorId(request: Request): string {
  const value = request.headers.get('x-admin-operator')?.trim()
  return value && value.length <= 128 ? value : 'admin'
}

function handleFeedbackError(error: unknown, status: (code: number, body: unknown) => unknown) {
  if (error instanceof FeedbackError) {
    return status(error.status, { error: error.code })
  }
  throw error
}

const idParams = t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) })
const messageIdParams = t.Object({ messageId: t.String({ minLength: 1, maxLength: 128 }) })

export const publicFeedbackRoutes = new Elysia({ prefix: '/api/feedback' })
  .use(resolveAuthUser)
  .onBeforeHandle(({ request, set, status }) => {
    set.headers['cache-control'] = 'private, no-store'
    if (!isCapabilityEnabled('accounts:login')) return capabilityUnavailable('accounts:login')
    const origin = request.headers.get('origin')
    if (
      request.method === 'POST' &&
      origin &&
      origin !== new URL(request.url).origin &&
      !config.auth.publicOrigins.includes(origin) &&
      !config.auth.frontendOrigins.includes(origin)
    ) {
      return status(403, { error: 'forbidden_origin' })
    }
  })
  .get('/summary', async ({ authUser, status }) => {
    if (!authUser) return status(401, { error: 'unauthorized' })
    return getUserFeedbackSummary(authUser.id)
  })
  .get('/', async ({ authUser, status }) => {
    if (!authUser) return status(401, { error: 'unauthorized' })
    return getUserFeedbackThread(authUser.id)
  })
  .post(
    '/read',
    ({ authUser, body, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      return markUserFeedbackRead(authUser.id, body.messageId)
    },
    { body: messageIdParams },
  )
  .post(
    '/messages',
    async ({ authUser, request, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      if (messageLimiter.over(authUser.id, 20)) return status(429, { error: 'rate_limited' })
      try {
        const upload = await readFeedbackUpload(request)
        return status(201, await postUserFeedbackMessage(authUser.id, upload))
      } catch (error) {
        return handleFeedbackError(error, status)
      }
    },
    { parse: 'none' },
  )
  .get(
    '/attachments/:messageId',
    async ({ authUser, params, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const asset = await readFeedbackAttachment(params.messageId, authUser.id)
      if (!asset) return status(404, { error: 'not_found' })
      return new Response(asset.bytes, {
        headers: {
          'content-type': asset.mimeType,
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, no-store',
        },
      })
    },
    { params: messageIdParams },
  )

export const internalFeedbackRoutes = new Elysia({ prefix: '/internal/admin/feedback' })
  .use(requireInternalService)
  .get(
    '/',
    ({ query }) =>
      listAdminFeedbackThreads({
        filter: query.filter,
        q: query.q,
      }),
    {
      query: t.Object({
        filter: t.Optional(t.String({ maxLength: 32 })),
        q: t.Optional(t.String({ maxLength: 128 })),
      }),
    },
  )
  .get(
    '/attachments/:messageId',
    async ({ params, status }) => {
      const asset = await readFeedbackAttachment(params.messageId)
      if (!asset) return status(404, { error: 'not_found' })
      return new Response(asset.bytes, {
        headers: {
          'content-type': asset.mimeType,
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, no-store',
        },
      })
    },
    { params: messageIdParams },
  )
  .get(
    '/:id',
    async ({ params, status }) => {
      try {
        return await getAdminFeedbackThread(params.id)
      } catch (error) {
        return handleFeedbackError(error, status)
      }
    },
    { params: idParams },
  )
  .post(
    '/:id/replies',
    async ({ body, params, request, status }) => {
      try {
        return status(
          201,
          await replyAdminFeedbackThread(params.id, body.body, operatorId(request)),
        )
      } catch (error) {
        return handleFeedbackError(error, status)
      }
    },
    {
      params: idParams,
      body: t.Object({
        body: t.String({ minLength: 1, maxLength: FEEDBACK_MESSAGE_MAX_CHARS }),
      }),
    },
  )
  .patch(
    '/:id/status',
    async ({ body, params, request, status }) => {
      try {
        return await updateAdminFeedbackThreadStatus({
          threadId: params.id,
          nextStatus: body.status,
          operatorId: operatorId(request),
          lastMessageAt: body.lastMessageAt,
        })
      } catch (error) {
        return handleFeedbackError(error, status)
      }
    },
    {
      params: idParams,
      body: t.Object({
        status: t.Union([t.Literal('open'), t.Literal('resolved')]),
        lastMessageAt: t.Integer({ minimum: 1, maximum: 8_640_000_000_000_000 }),
      }),
    },
  )

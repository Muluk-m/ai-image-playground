import { ANNOUNCEMENT_EXPORT_FORMAT, ANNOUNCEMENT_EXPORT_VERSION } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import {
  AnnouncementOperationError,
  archiveAnnouncement,
  createAnnouncement,
  getAnnouncement,
  importAnnouncement,
  listAnnouncements,
  listPublicAnnouncements,
  markAnnouncementRead,
  markAnnouncementsRead,
  normalizeAnnouncementLocale,
  publishAnnouncement,
  unpublishAnnouncement,
  updateAnnouncement,
} from '../lib/announcements'
import { requireInternalService, resolveAuthUser } from '../lib/user-auth'

const operationStatus: Record<AnnouncementOperationError['code'], number> = {
  not_found: 404,
  invalid_announcement: 400,
  invalid_reason: 400,
  invalid_window: 400,
}

function handleOperationError(error: unknown, status: (code: number, body: unknown) => unknown) {
  if (!(error instanceof AnnouncementOperationError)) throw error
  return status(operationStatus[error.code], { error: error.code })
}

function operatorId(request: Request): string {
  const value = request.headers.get('x-admin-operator')?.trim()
  return value && value.length <= 128 ? value : 'admin'
}

const idParams = t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) })
const reasonBody = t.Object({
  reason: t.String({ minLength: 1, maxLength: 500 }),
})
const draftBody = t.Object({
  type: t.Union([t.Literal('feature'), t.Literal('improvement'), t.Literal('notice')]),
  importance: t.Union([t.Literal('normal'), t.Literal('major')]),
  titleZh: t.String({ minLength: 1, maxLength: 80 }),
  bodyZh: t.String({ maxLength: 20_000 }),
  titleEn: t.Nullable(t.String({ maxLength: 80 })),
  bodyEn: t.Nullable(t.String({ maxLength: 20_000 })),
  coverKey: t.Nullable(t.String({ maxLength: 2048 })),
  ctaLabel: t.Nullable(t.String({ maxLength: 40 })),
  ctaUrl: t.Nullable(t.String({ maxLength: 2048 })),
  versionTag: t.Nullable(t.String({ maxLength: 32 })),
  audience: t.Union([t.Literal('all'), t.Literal('logged_in'), t.Literal('anonymous')]),
  publishAt: t.Nullable(t.Number()),
  expireAt: t.Nullable(t.Number()),
})

function webOrigin(): string | null {
  const value = process.env.PUBLIC_WEB_ORIGIN?.trim().replace(/\/+$/, '')
  return value || null
}

export const publicAnnouncementRoutes = new Elysia({ prefix: '/api/announcements' })
  .use(resolveAuthUser)
  .get(
    '/',
    ({ authUser, query }) =>
      listPublicAnnouncements(normalizeAnnouncementLocale(query.locale), authUser?.id ?? null),
    {
      query: t.Object({
        locale: t.Optional(t.String({ maxLength: 8 })),
      }),
    },
  )
  .post(
    '/read',
    async ({ authUser, body, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      await markAnnouncementsRead(body.ids, authUser.id, body.dismissed ?? false)
      return { ok: true }
    },
    {
      body: t.Object({
        ids: t.Array(t.String({ minLength: 1, maxLength: 128 }), { maxItems: 200 }),
        dismissed: t.Optional(t.Boolean()),
      }),
    },
  )
  .post(
    '/:id/read',
    async ({ authUser, body, params, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      try {
        await markAnnouncementRead(params.id, authUser.id, body.dismissed ?? false)
        return { ok: true }
      } catch (error) {
        return handleOperationError(error, status)
      }
    },
    {
      params: idParams,
      body: t.Object({ dismissed: t.Optional(t.Boolean()) }),
    },
  )

export const internalAnnouncementRoutes = new Elysia({ prefix: '/internal/admin' })
  .use(requireInternalService)
  .get(
    '/announcements',
    ({ query }) =>
      listAnnouncements(
        {
          status: query.status,
          type: query.type,
          q: query.q,
          language: query.language,
          withinDays: query.withinDays ? Number(query.withinDays) : undefined,
        },
        webOrigin(),
      ),
    {
      query: t.Object({
        status: t.Optional(t.String({ maxLength: 32 })),
        type: t.Optional(t.String({ maxLength: 32 })),
        q: t.Optional(t.String({ maxLength: 128 })),
        language: t.Optional(t.String({ maxLength: 16 })),
        withinDays: t.Optional(t.String({ maxLength: 8 })),
      }),
    },
  )
  .get(
    '/announcements/:id',
    async ({ params, status }) => {
      try {
        return { item: await getAnnouncement(params.id), webOrigin: webOrigin() }
      } catch (error) {
        return handleOperationError(error, status)
      }
    },
    { params: idParams },
  )
  .post(
    '/announcements',
    async ({ body, request, status }) => {
      try {
        return status(201, { item: await createAnnouncement(body, operatorId(request)) })
      } catch (error) {
        return handleOperationError(error, status)
      }
    },
    { body: draftBody },
  )
  .post(
    '/announcements/import',
    async ({ body, request, status }) => {
      try {
        return status(201, { item: await importAnnouncement(body, operatorId(request)) })
      } catch (error) {
        return handleOperationError(error, status)
      }
    },
    {
      body: t.Object({
        format: t.Literal(ANNOUNCEMENT_EXPORT_FORMAT),
        version: t.Literal(ANNOUNCEMENT_EXPORT_VERSION),
        announcement: draftBody,
      }),
    },
  )
  .put(
    '/announcements/:id',
    async ({ body, params, request, status }) => {
      try {
        return { item: await updateAnnouncement(params.id, body, operatorId(request)) }
      } catch (error) {
        return handleOperationError(error, status)
      }
    },
    { params: idParams, body: draftBody },
  )
  .post(
    '/announcements/:id/publish',
    async ({ body, params, request, status }) => {
      try {
        return {
          item: await publishAnnouncement(
            params.id,
            body.reason,
            body.publishAt ?? null,
            operatorId(request),
          ),
        }
      } catch (error) {
        return handleOperationError(error, status)
      }
    },
    {
      params: idParams,
      body: t.Object({
        reason: t.String({ minLength: 1, maxLength: 500 }),
        publishAt: t.Optional(t.Nullable(t.Number())),
      }),
    },
  )
  .post(
    '/announcements/:id/unpublish',
    async ({ body, params, request, status }) => {
      try {
        return {
          item: await unpublishAnnouncement(params.id, body.reason, operatorId(request)),
        }
      } catch (error) {
        return handleOperationError(error, status)
      }
    },
    { params: idParams, body: reasonBody },
  )
  .post(
    '/announcements/:id/archive',
    async ({ body, params, request, status }) => {
      try {
        return { item: await archiveAnnouncement(params.id, body.reason, operatorId(request)) }
      } catch (error) {
        return handleOperationError(error, status)
      }
    },
    { params: idParams, body: reasonBody },
  )

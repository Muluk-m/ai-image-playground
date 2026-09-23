import { INSPIRATION_KINDS, INSPIRATION_STATUSES } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import {
  createInspirationCategory,
  createInspirationItem,
  deleteInspirationCategory,
  deleteInspirationItem,
  getInspirationItem,
  InspirationOperationError,
  listInspirationCategories,
  listInspirationItems,
  publicInspirationManifest,
  setInspirationStatus,
  updateInspirationCategory,
  updateInspirationItem,
} from '../lib/inspirations'
import { createInspirationUploadTarget } from '../lib/public-assets'
import { requireInternalService } from '../lib/user-auth'

const qualitySchema = t.Union([
  t.Literal('auto'),
  t.Literal('low'),
  t.Literal('medium'),
  t.Literal('high'),
])
const kindSchema = t.Union(INSPIRATION_KINDS.map((kind) => t.Literal(kind)))
const statusSchema = t.Union(INSPIRATION_STATUSES.map((status) => t.Literal(status)))
const referenceSchema = t.Object({
  key: t.String({ minLength: 1, maxLength: 2048 }),
  name: t.String({ minLength: 1, maxLength: 256 }),
})
const writeSchema = t.Object({
  id: t.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$' }),
  kind: kindSchema,
  featured: t.Boolean(),
  title: t.String({ minLength: 1, maxLength: 256 }),
  description: t.Nullable(t.String({ maxLength: 2000 })),
  categoryId: t.String({ minLength: 1, maxLength: 128 }),
  prompt: t.String({ minLength: 1, maxLength: 50_000 }),
  recommendedProvider: t.String({ minLength: 1, maxLength: 128 }),
  recommendedModel: t.String({ minLength: 1, maxLength: 256 }),
  params: t.Object({
    size: t.String({ minLength: 1, maxLength: 64 }),
    quality: t.Optional(qualitySchema),
    n: t.Optional(t.Integer({ minimum: 1, maximum: 4 })),
  }),
  tags: t.Array(t.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }),
  coverKey: t.String({ minLength: 1, maxLength: 2048 }),
  imageKey: t.Nullable(t.String({ maxLength: 2048 })),
  referenceImages: t.Array(referenceSchema, { maxItems: 8 }),
  skillName: t.Nullable(t.String({ maxLength: 128 })),
  sourceUrl: t.Nullable(t.String({ maxLength: 2048 })),
  author: t.Nullable(t.String({ maxLength: 256 })),
  sort: t.Integer(),
})

const operationStatus: Record<InspirationOperationError['code'], number> = {
  item_not_found: 404,
  category_not_found: 404,
  category_in_use: 409,
  invalid_item: 400,
  invalid_template: 400,
  invalid_skill: 400,
  invalid_model: 400,
  published_item_must_be_archived: 409,
  id_taken: 409,
  category_name_taken: 409,
}

function handleOperationError(error: unknown, status: (code: number, body: unknown) => unknown) {
  if (!(error instanceof InspirationOperationError)) throw error
  return status(operationStatus[error.code], { error: error.code })
}

function operatorId(request: Request): string {
  const value = request.headers.get('x-admin-operator')?.trim()
  return value && value.length <= 128 ? value : 'admin'
}

export const publicInspirationRoutes = new Elysia({ prefix: '/api/inspirations' }).get(
  '/manifest',
  async ({ set }) => {
    set.headers['cache-control'] = 'public, max-age=300, stale-while-revalidate=86400'
    return publicInspirationManifest()
  },
)

export const internalInspirationRoutes = new Elysia({ prefix: '/internal/admin' })
  .use(requireInternalService)
  .get('/inspirations', ({ query }) => listInspirationItems(query), {
    query: t.Object({
      status: t.Optional(t.String({ maxLength: 32 })),
      kind: t.Optional(t.String({ maxLength: 32 })),
      q: t.Optional(t.String({ maxLength: 128 })),
    }),
  })
  .get(
    '/inspirations/:id',
    async ({ params, status }) => {
      const item = await getInspirationItem(params.id)
      return item ?? status(404, { error: 'item_not_found' })
    },
    { params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }) },
  )
  .post(
    '/inspirations',
    async ({ body, request, status }) => {
      try {
        return status(201, { item: await createInspirationItem(body, operatorId(request)) })
      } catch (error) {
        return handleOperationError(error, status)
      }
    },
    { body: writeSchema },
  )
  .put(
    '/inspirations/:id',
    async ({ body, params, request, status }) => {
      try {
        return { item: await updateInspirationItem(params.id, body, operatorId(request)) }
      } catch (error) {
        return handleOperationError(error, status)
      }
    },
    {
      params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }),
      body: writeSchema,
    },
  )
  .delete(
    '/inspirations/:id',
    async ({ params, request, status }) => {
      try {
        await deleteInspirationItem(params.id, operatorId(request))
        return { ok: true }
      } catch (error) {
        return handleOperationError(error, status)
      }
    },
    { params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }) },
  )
  .post(
    '/inspirations/:id/status',
    async ({ body, params, request, status }) => {
      try {
        return {
          item: await setInspirationStatus(params.id, body.status, operatorId(request)),
        }
      } catch (error) {
        return handleOperationError(error, status)
      }
    },
    {
      params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }),
      body: t.Object({ status: statusSchema }),
    },
  )
  .post(
    '/inspirations/uploads',
    ({ body, status }) => {
      try {
        return createInspirationUploadTarget(body)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'upload_unavailable'
        const code =
          message === 'unsupported_content_type' || message === 'content_type_mismatch' ? 400 : 503
        return status(code, { error: message })
      }
    },
    {
      body: t.Object({
        filename: t.String({ minLength: 1, maxLength: 256 }),
        contentType: t.String({ minLength: 1, maxLength: 128 }),
      }),
    },
  )
  .get('/inspiration-categories', () => listInspirationCategories())
  .post(
    '/inspiration-categories',
    async ({ body, request, status }) => {
      try {
        return status(201, {
          category: await createInspirationCategory(body, operatorId(request)),
        })
      } catch (error) {
        return handleOperationError(error, status)
      }
    },
    {
      body: t.Object({
        id: t.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$' }),
        name: t.String({ minLength: 1, maxLength: 128 }),
        sort: t.Integer(),
      }),
    },
  )
  .put(
    '/inspiration-categories/:id',
    async ({ body, params, request, status }) => {
      try {
        return {
          category: await updateInspirationCategory(params.id, body, operatorId(request)),
        }
      } catch (error) {
        return handleOperationError(error, status)
      }
    },
    {
      params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }),
      body: t.Object({ name: t.String({ minLength: 1, maxLength: 128 }), sort: t.Integer() }),
    },
  )
  .delete(
    '/inspiration-categories/:id',
    async ({ params, request, status }) => {
      try {
        await deleteInspirationCategory(params.id, operatorId(request))
        return { ok: true }
      } catch (error) {
        return handleOperationError(error, status)
      }
    },
    { params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }) },
  )

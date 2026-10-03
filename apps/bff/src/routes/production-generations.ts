import { Elysia, t } from 'elysia'
import { ProductionError } from '../lib/agent/production'
import {
  adoptProductionGeneration,
  createProductionGenerationDraft,
  editProductionGenerationDraft,
  listProductionGenerations,
} from '../lib/agent/production-generation'
import { badRequestOnValidation } from '../lib/http'
import { resolveAuthUser } from '../lib/user-auth'
import { productionReferenceSchema } from './production-asset-schema'
import { productionVideoSchema } from './production-clip-schema'

export const productionGenerationParamsSchema = t.Object({
  size: t.Optional(t.String({ maxLength: 32 })),
  quality: t.Optional(t.String({ maxLength: 32 })),
  output_format: t.Optional(t.String({ maxLength: 16 })),
  output_compression: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
  gemini_aspect_ratio: t.Optional(t.String({ maxLength: 16 })),
  gemini_image_size: t.Optional(t.String({ maxLength: 16 })),
  gemini_thinking_level: t.Optional(t.String({ maxLength: 16 })),
})
const generationFields = {
  prompt: t.String({ minLength: 1, maxLength: 8000 }),
  model: t.String({ minLength: 1, maxLength: 128 }),
  params: t.Optional(productionGenerationParamsSchema),
  video: t.Optional(productionVideoSchema),
  references: t.Array(
    t.Object({
      reference: productionReferenceSchema,
      usage: t.Optional(
        t.Union([t.Literal('first-frame'), t.Literal('last-frame'), t.Literal('reference')]),
      ),
    }),
    { maxItems: 16 },
  ),
}
export const productionGenerationRoutes = new Elysia()
  .use(badRequestOnValidation())
  .use(resolveAuthUser)
  .onError(({ error, status }) => {
    if (error instanceof ProductionError)
      return status(
        error.code === 'production_conflict' || error.code === 'production_operation_reused'
          ? 409
          : error.code === 'production_invalid'
            ? 400
            : 404,
        { error: error.code, ...(error.current ? { current: error.current } : {}) },
      )
  })
  .get(
    '/api/agent/conversations/:id/production/generations',
    async ({ params, query, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      return {
        generations: await listProductionGenerations(
          params.id,
          authUser.id,
          undefined,
          query.messageId,
        ),
      }
    },
    { query: t.Object({ messageId: t.Optional(t.String({ minLength: 1, maxLength: 128 })) }) },
  )
  .post(
    '/api/agent/conversations/:id/production/generations',
    async ({ params, body, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      return { generation: await createProductionGenerationDraft(params.id, authUser.id, body) }
    },
    {
      body: t.Object({
        ...generationFields,
        operationId: t.String({ minLength: 1, maxLength: 128 }),
        baseRevision: t.Integer({ minimum: 1 }),
        target: t.Union([t.Literal('look'), t.Literal('location'), t.Literal('clip')]),
        targetId: t.String({ minLength: 1, maxLength: 128 }),
      }),
    },
  )

  .patch(
    '/api/agent/conversations/:id/production/generations/:draftId',
    async ({ params, body, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      return {
        generation: await editProductionGenerationDraft(
          params.id,
          authUser.id,
          params.draftId,
          body,
        ),
      }
    },
    { body: t.Object({ ...generationFields, draftRevision: t.Integer({ minimum: 1 }) }) },
  )
  .post(
    '/api/agent/conversations/:id/production/generations/:draftId/adopt',
    async ({ params, body, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const record = await adoptProductionGeneration(params.id, authUser.id, params.draftId, body)
      return { document: record.document }
    },
    {
      body: t.Object({
        operationId: t.String({ minLength: 1, maxLength: 120 }),
        baseRevision: t.Integer({ minimum: 1 }),
        artifactId: t.String({ minLength: 1, maxLength: 128 }),
      }),
    },
  )

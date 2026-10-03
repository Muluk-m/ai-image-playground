import { Elysia, t } from 'elysia'
import { ProductionError } from '../lib/agent/production'
import {
  inspectProductionExport,
  PRODUCTION_EXPORT_BATCH_MAX,
  streamProductionExport,
} from '../lib/agent/production-export'
import { badRequestOnValidation } from '../lib/http'
import { resolveAuthUser } from '../lib/user-auth'
import { productionReferenceSchema } from './production-asset-schema'
export const productionExportRoutes = new Elysia()
  .use(badRequestOnValidation())
  .use(resolveAuthUser)
  .onError(({ error, status }) => {
    if (error instanceof ProductionError) return status(404, { error: error.code })
  })
  .post(
    '/api/agent/conversations/:id/production/export/inspect',
    async ({ params, body, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      return inspectProductionExport(params.id, authUser.id, body.revision, body.references)
    },
    {
      body: t.Object({
        revision: t.Integer({ minimum: 1 }),
        references: t.Array(productionReferenceSchema, { maxItems: PRODUCTION_EXPORT_BATCH_MAX }),
      }),
    },
  )
  .get(
    '/api/agent/conversations/:id/production/export/reference',
    async ({ params, query, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const reference =
        query.kind === 'media'
          ? { kind: 'media' as const, mediaId: query.id }
          : query.kind === 'artifact'
            ? { kind: 'artifact' as const, artifactId: query.id }
            : { kind: 'asset' as const, imageId: query.id }
      return streamProductionExport(
        params.id,
        authUser.id,
        query.revision,
        reference,
        query.download === 'true',
      )
    },
    {
      query: t.Object({
        revision: t.Numeric({ minimum: 1 }),
        kind: t.Union([t.Literal('media'), t.Literal('asset'), t.Literal('artifact')]),
        id: t.String({ minLength: 1, maxLength: 128 }),
        download: t.Optional(t.Literal('true')),
      }),
    },
  )

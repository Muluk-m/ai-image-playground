import { Elysia, t } from 'elysia'
import {
  adoptProductionProposal,
  discardProductionProposal,
  ProductionError,
  readProduction,
  restoreProduction,
  writeProduction,
} from '../lib/agent/production'
import {
  adoptProductionAssets,
  discardProductionAssets,
  previewProductionReference,
} from '../lib/agent/production-assets'
import { productionDependencyStates } from '../lib/agent/production-dependencies'
import { refreshProductionDependencies } from '../lib/agent/production-dependency-refresh'
import {
  adoptProductionStoryboard,
  discardProductionStoryboard,
} from '../lib/agent/production-storyboard'
import { badRequestOnValidation } from '../lib/http'
import { resolveAuthUser } from '../lib/user-auth'
import { productionAssetFields } from './production-asset-schema'
import { productionClipSchema } from './production-clip-schema'
import { productionExportRoutes } from './production-export'
import { productionGenerationRoutes } from './production-generations'
import { productionShotsSchema } from './production-storyboard-schema'

export const productionRoutes = new Elysia()
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
  .get('/api/agent/conversations/:id/production', async ({ params, query, authUser, status }) => {
    if (!authUser) return status(401, { error: 'unauthorized' })
    const record = await readProduction(params.id, authUser.id)
    return {
      document: record?.document ?? null,
      ...(record
        ? productionDependencyStates(record.document.content)
        : { shotDependencyStates: [], dependencyStates: [] }),
      history: query.history === 'true' ? (record?.history ?? []) : [],
      ...(query.proposals === 'true' ? { proposals: record?.proposals ?? [] } : {}),
      ...(query.assetProposals === 'true' ? { assetProposals: record?.assetProposals ?? [] } : {}),
      ...(query.storyboard === 'true'
        ? { storyboardProposals: record?.storyboardProposals ?? [] }
        : {}),
    }
  })
  .put(
    '/api/agent/conversations/:id/production',
    async ({ params, body, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const record = await writeProduction(params.id, authUser.id, body, 'user')
      return { document: record.document, history: record.history }
    },
    {
      body: t.Object({
        operationId: t.String({ minLength: 1, maxLength: 128 }),
        baseRevision: t.Integer({ minimum: 0 }),
        content: t.Object({
          shots: t.Optional(productionShotsSchema),
          clips: t.Optional(productionClipSchema),
          characters: t.Optional(productionAssetFields.characters),
          locations: t.Optional(productionAssetFields.locations),
          title: t.String({ maxLength: 200 }),
          setting: t.String({ maxLength: 100000 }),
          outline: t.String({ maxLength: 100000 }),
          scenes: t.Array(
            t.Object({
              id: t.String({ minLength: 1, maxLength: 128 }),
              title: t.String({ maxLength: 200 }),
              body: t.String({ maxLength: 100000 }),
            }),
            { maxItems: 100 },
          ),
        }),
      }),
    },
  )

  .post(
    '/api/agent/conversations/:id/production/restore',
    async ({ params, body, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const record = await restoreProduction(params.id, authUser.id, body)
      return { document: record.document, history: record.history }
    },
    {
      body: t.Object({
        operationId: t.String({ minLength: 1, maxLength: 128 }),
        baseRevision: t.Integer({ minimum: 0 }),
        revision: t.Integer({ minimum: 1 }),
      }),
    },
  )

  .post(
    '/api/agent/conversations/:id/production/proposals/:proposalId/adopt',
    async ({ params, body, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const record = await adoptProductionProposal(params.id, authUser.id, params.proposalId, body)
      return {
        document: record.document,
        history: record.history,
        proposals: record.proposals ?? [],
      }
    },
    {
      body: t.Object({
        operationId: t.String({ minLength: 1, maxLength: 128 }),
        baseRevision: t.Integer({ minimum: 1 }),
      }),
    },
  )
  .post(
    '/api/agent/conversations/:id/production/proposals/:proposalId/discard',
    async ({ params, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const record = await discardProductionProposal(params.id, authUser.id, params.proposalId)
      return { document: record.document, history: [], proposals: record.proposals ?? [] }
    },
  )

  .get(
    '/api/agent/conversations/:id/production/references/preview',
    async ({ params, query, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const reference =
        query.kind === 'media'
          ? { kind: 'media' as const, mediaId: query.id }
          : query.kind === 'artifact'
            ? { kind: 'artifact' as const, artifactId: query.id }
            : { kind: 'asset' as const, imageId: query.id }
      return previewProductionReference(params.id, authUser.id, reference)
    },
    {
      query: t.Object({
        kind: t.Union([t.Literal('media'), t.Literal('artifact'), t.Literal('asset')]),
        id: t.String({ minLength: 1, maxLength: 128 }),
      }),
    },
  )
  .post(
    '/api/agent/conversations/:id/production/asset-proposals/:proposalId/adopt',
    async ({ params, body, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const record = await adoptProductionAssets(params.id, authUser.id, params.proposalId, body)
      return { document: record.document, assetProposals: record.assetProposals ?? [] }
    },
    {
      body: t.Object({
        operationId: t.String({ minLength: 1, maxLength: 128 }),
        baseRevision: t.Integer({ minimum: 1 }),
      }),
    },
  )
  .post(
    '/api/agent/conversations/:id/production/asset-proposals/:proposalId/discard',
    async ({ params, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const record = await discardProductionAssets(params.id, authUser.id, params.proposalId)
      return { document: record.document, assetProposals: record.assetProposals ?? [] }
    },
  )
  .post(
    '/api/agent/conversations/:id/production/storyboard/:proposalId/adopt',
    async ({ params, body, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const record = await adoptProductionStoryboard(
        params.id,
        authUser.id,
        params.proposalId,
        body,
      )
      return {
        document: record.document,
        history: record.history,
        storyboardProposals: record.storyboardProposals ?? [],
      }
    },
    {
      body: t.Object({
        operationId: t.String({ minLength: 1, maxLength: 128 }),
        baseRevision: t.Integer({ minimum: 1 }),
      }),
    },
  )
  .post(
    '/api/agent/conversations/:id/production/storyboard/:proposalId/discard',
    async ({ params, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const record = await discardProductionStoryboard(params.id, authUser.id, params.proposalId)
      return {
        document: record.document,
        history: [],
        storyboardProposals: record.storyboardProposals ?? [],
      }
    },
  )

  .use(productionGenerationRoutes)
  .post(
    '/api/agent/conversations/:id/production/shots/:shotId/refresh',
    async ({ params, body, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const record = await refreshProductionDependencies(
        params.id,
        authUser.id,
        { kind: 'shot', id: params.shotId },
        body,
      )
      return {
        document: record.document,
        history: record.history,
        ...productionDependencyStates(record.document.content),
      }
    },
    {
      body: t.Object({
        operationId: t.String({ minLength: 1, maxLength: 128 }),
        baseRevision: t.Integer({ minimum: 1 }),
      }),
    },
  )

  .post(
    '/api/agent/conversations/:id/production/clips/:clipId/refresh',
    async ({ params, body, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const record = await refreshProductionDependencies(
        params.id,
        authUser.id,
        { kind: 'clip', id: params.clipId },
        body,
      )
      return {
        document: record.document,
        history: record.history,
        ...productionDependencyStates(record.document.content),
      }
    },
    {
      body: t.Object({
        operationId: t.String({ minLength: 1, maxLength: 128 }),
        baseRevision: t.Integer({ minimum: 1 }),
      }),
    },
  )
  .use(productionExportRoutes)

import { and, asc, eq, isNull } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db, schema } from '../db/client'
import {
  batchExecutionAvailable,
  confirmAgentBatch,
  controlAgentBatch,
  quoteAgentBatchRetry,
  repriceAgentBatch,
} from '../lib/agent/batch-execution'
import {
  BatchPlanError,
  batchPlansAvailable,
  cancelAgentBatchPlan,
  readAgentBatchPlan,
  updateAgentBatchPlan,
} from '../lib/agent/batch-plans'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { badRequestOnValidation } from '../lib/http'
import { resolveAuthUser } from '../lib/user-auth'

const batchItemFields = {
  key: t.String({ minLength: 1, maxLength: 128 }),
  ordinal: t.Integer({ minimum: 0, maximum: 99 }),
  inputs: t.Array(
    t.Object({
      imageId: t.String({ minLength: 1, maxLength: 128 }),
      mediaId: t.String({ format: 'uuid' }),
      name: t.Optional(t.String({ maxLength: 200 })),
      maskMediaId: t.Optional(t.String({ format: 'uuid' })),
      editAction: t.Optional(
        t.Union([
          t.Literal('inpaint'),
          t.Literal('erase'),
          t.Literal('crop'),
          t.Literal('outpaint'),
        ]),
      ),
      regions: t.Optional(
        t.Array(
          t.Object({
            x: t.Number({ minimum: 0, maximum: 1 }),
            y: t.Number({ minimum: 0, maximum: 1 }),
            width: t.Number({ exclusiveMinimum: 0, maximum: 1 }),
            height: t.Number({ exclusiveMinimum: 0, maximum: 1 }),
          }),
          { maxItems: 32 },
        ),
      ),
    }),
    { minItems: 1, maxItems: 100 },
  ),
  prompt: t.String({ minLength: 1, maxLength: 4000 }),
  dependencies: t.Array(t.String({ minLength: 1, maxLength: 128 }), { maxItems: 100 }),
}
const batchItemSchema = t.Union([
  t.Object({
    ...batchItemFields,
    kind: t.Literal('generation'),
    params: t.Object({
      model: t.String({ minLength: 1, maxLength: 128 }),
      provider: t.Union([t.Literal('openai-compat'), t.Literal('gemini')]),
      size: t.Optional(t.String({ maxLength: 32 })),
      quality: t.Optional(t.String({ maxLength: 16 })),
      output_format: t.Optional(t.String({ maxLength: 16 })),
      output_compression: t.Optional(t.Integer({ minimum: 0, maximum: 100 })),
      gemini_aspect_ratio: t.Optional(t.String({ maxLength: 16 })),
      gemini_image_size: t.Optional(t.String({ maxLength: 16 })),
      gemini_thinking_level: t.Optional(t.String({ maxLength: 16 })),
    }),
  }),
  t.Object({
    ...batchItemFields,
    kind: t.Literal('analysis'),
    params: t.Object({
      model: t.String({ minLength: 1, maxLength: 128 }),
      intent: t.Optional(t.Union([t.Literal('inspection'), t.Literal('joint_comparison')])),
    }),
  }),
])

export const agentBatchRoutes = new Elysia({ name: 'agent-batches' })
  .use(badRequestOnValidation())
  .onError(({ error, status }) => {
    if (error instanceof BatchPlanError) return status(error.status, { error: error.code })
  })
  .use(resolveAuthUser)
  .onBeforeHandle(({ authUser, status }) => {
    if (!authUser) return status(401, { error: 'unauthorized' })
    if (!isCapabilityEnabled('agent:chat')) return capabilityUnavailable('agent:chat')
  })
  .get(
    '/api/agent/conversations/:id/batches',
    async ({ params, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const [conversation] = await db
        .select({ id: schema.agent_conversations.id })
        .from(schema.agent_conversations)
        .where(
          and(
            eq(schema.agent_conversations.id, params.id),
            eq(schema.agent_conversations.user_id, authUser.id),
            isNull(schema.agent_conversations.deleted_at),
          ),
        )
      if (!conversation) return status(404, { error: 'conversation_not_found' })
      const batches = await db
        .select({ id: schema.agent_batches.id })
        .from(schema.agent_batches)
        .where(
          and(
            eq(schema.agent_batches.user_id, authUser.id),
            eq(schema.agent_batches.conversation_id, params.id),
          ),
        )
        .orderBy(asc(schema.agent_batches.created_at), asc(schema.agent_batches.id))
      return { batches }
    },
    { params: t.Object({ id: t.String() }) },
  )
  .get(
    '/api/agent/batches/:id',
    async ({ params, query, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const page = await readAgentBatchPlan(authUser.id, params.id, query)
      return page ?? status(404, { error: 'batch_not_found' })
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({
        limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
        cursor: t.Optional(t.String({ maxLength: 1024 })),
      }),
    },
  )

  .patch(
    '/api/agent/batches/:id',
    async ({ params, body, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      if (!batchPlansAvailable({ userId: authUser.id }))
        return capabilityUnavailable('agent:batch-plans')
      await updateAgentBatchPlan(authUser.id, params.id, body)
      return await readAgentBatchPlan(authUser.id, params.id)
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        expectedVersion: t.Integer({ minimum: 1 }),
        title: t.String({ minLength: 1, maxLength: 120 }),
        rule: t.String({ minLength: 1, maxLength: 4000 }),
        items: t.Array(batchItemSchema, { minItems: 1, maxItems: 100 }),
      }),
    },
  )

  .post(
    '/api/agent/batches/:id/cancel',
    async ({ params, body, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      await cancelAgentBatchPlan(authUser.id, params.id, body.expectedVersion)
      return await readAgentBatchPlan(authUser.id, params.id)
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ expectedVersion: t.Integer({ minimum: 1 }) }),
    },
  )

  .post(
    '/api/agent/batches/:id/confirm',
    async ({ params, body, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      if (!batchExecutionAvailable(authUser.id))
        return capabilityUnavailable('agent:batch-execution')
      await confirmAgentBatch(authUser.id, params.id, body)
      return await readAgentBatchPlan(authUser.id, params.id)
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        commandId: t.String({ minLength: 1, maxLength: 128 }),
        expectedVersion: t.Integer({ minimum: 1 }),
        expectedDigest: t.String({ pattern: '^[a-f0-9]{64}$' }),
        deviceId: t.String({ minLength: 1, maxLength: 128 }),
      }),
    },
  )

  .post(
    '/api/agent/batches/:id/pause',
    async ({ params, body, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      await controlAgentBatch(authUser.id, params.id, 'pause', body)
      return await readAgentBatchPlan(authUser.id, params.id)
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        commandId: t.String({ minLength: 1, maxLength: 128 }),
        expectedVersion: t.Integer({ minimum: 1 }),
      }),
    },
  )
  .post(
    '/api/agent/batches/:id/resume',
    async ({ params, body, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      if (!batchExecutionAvailable(authUser.id))
        return capabilityUnavailable('agent:batch-execution')
      await controlAgentBatch(authUser.id, params.id, 'resume', body)
      return await readAgentBatchPlan(authUser.id, params.id)
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        commandId: t.String({ minLength: 1, maxLength: 128 }),
        expectedVersion: t.Integer({ minimum: 1 }),
        expectedDigest: t.String({ pattern: '^[a-f0-9]{64}$' }),
        deviceId: t.String({ minLength: 1, maxLength: 128 }),
      }),
    },
  )

  .post(
    '/api/agent/batches/:id/reprice',
    async ({ params, body, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      if (!batchExecutionAvailable(authUser.id))
        return capabilityUnavailable('agent:batch-execution')
      await repriceAgentBatch(authUser.id, params.id, body)
      return await readAgentBatchPlan(authUser.id, params.id)
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        commandId: t.String({ minLength: 1, maxLength: 128 }),
        expectedVersion: t.Integer({ minimum: 1 }),
      }),
    },
  )

  .post(
    '/api/agent/batches/:id/retry-quote',
    async ({ params, body, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      if (!batchExecutionAvailable(authUser.id))
        return capabilityUnavailable('agent:batch-execution')
      await quoteAgentBatchRetry(authUser.id, params.id, body)
      return await readAgentBatchPlan(authUser.id, params.id)
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        commandId: t.String({ minLength: 1, maxLength: 128 }),
        expectedVersion: t.Integer({ minimum: 1 }),
        itemKeys: t.Array(t.String({ minLength: 1, maxLength: 128 }), {
          minItems: 1,
          maxItems: 100,
        }),
      }),
    },
  )

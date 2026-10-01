// Intended destination: apps/bff/src/__tests__/routes/agent-batch-comparison-limit.test.ts
import { afterAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'
import { fixturePng } from '../helpers/rasterFixture'

process.env.DATABASE_URL = await resetTestDatabase('analysis_joint_limit')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture'
process.env.AGENT_CHAT_MODEL = 'analysis-auth-model'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../batch-execution-operator-config.json',
)
const billing = installRecordingTaskHooks()
const { db, schema, close } = await import('../../db/client')
const { config } = await import('../../config')
const { loadPrivateBffOverlay, _setPrivateBffOverlayForTesting } = await import(
  '../../lib/private-overlay'
)
const overlay = await loadPrivateBffOverlay()
_setPrivateBffOverlayForTesting({
  ...overlay,
  taskHooks: {
    ...overlay.taskHooks,
    async quoteTokenTask({ model, estimatedInputTokens }) {
      return {
        estimatedCredits: 7,
        pricing: {
          model,
          unit: 'kilo_token',
          quantity: 1,
          unitMultiplier: 1,
          baseUnitCredits: 7,
          outputPriceRatio: 1,
          cachedInputPriceRatio: 0,
          inputEstimateTokens: estimatedInputTokens,
          outputReserveTokens: 1000,
          exemption: 'none',
          pricingVersion: 'auth-quote-v1',
          quotedAt: 1,
          validUntil: null,
        },
      }
    },
  },
})
const { setChatFetchForTesting } = await import('../../lib/chatCompletion')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')
const { storeMedia } = await import('../../lib/projectMedia')
setDurableMediaStoreForTesting(
  Object.assign(new InMemoryObjectStore(), { sign: (key: string) => `http://media.test/${key}` }),
)
afterAll(async () => {
  setChatFetchForTesting()
  setDurableMediaStoreForTesting()
  _setPrivateBffOverlayForTesting()
  await close()
})

it.each([
  'initial',
  'followup',
] as const)('returns explicit choices without decomposing or charging an over-budget joint comparison: %s', async (phase) => {
  const operator = config.operator
  const agent = config.agent
  config.operator = {
    ...operator,
    capabilities: { ...operator.capabilities, 'agent:batch-analysis': true },
  }
  config.agent = { ...agent, contextWindow: 100, maxTokens: 64 }
  const id = `joint-limit-${phase}`
  const now = Date.now()
  try {
    await db.insert(schema.users).values({
      id,
      username: id,
      password_hash: 'fixture',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    await db
      .insert(schema.agent_conversations)
      .values({ id, user_id: id, title: 'compare', created_at: now, updated_at: now })
    const references = []
    for (const [ordinal, imageId] of ['first', 'second'].entries()) {
      const media = await storeMedia(
        id,
        await fixturePng(ordinal ? '#123456' : '#abcdef'),
        'image/png',
      )
      references.push({ imageId, mediaId: media.id })
    }
    const { createAgentImageSource } = await import('../../lib/agent/images')
    const { planImageBatch } = await import('../../lib/agent/tools/planImageBatch')
    const { toolResultBlock } = await import('../../lib/agent/tools/adapter')
    let dispatched = 0
    setChatFetchForTesting(async () => {
      dispatched++
      throw new Error('over-budget comparison must not call the model')
    })
    if (phase === 'followup') {
      const empty = {
        status: 'available' as const,
        estimatedCredits: 0,
        estimatedChargeCredits: 0,
        snapshots: [],
      }
      await db.insert(schema.agent_batches).values({
        id,
        user_id: id,
        conversation_id: id,
        origin_turn_id: 'origin',
        tool_call_id: 'plan',
        experience: 'chat',
        status: 'running',
        confirmed_version: 1,
        created_at: now,
        updated_at: now,
      })
      await db.insert(schema.agent_batch_plans).values({
        batch_id: id,
        version: 1,
        title: 'inspect',
        rule: 'inspect',
        digest: 'a'.repeat(64),
        item_count: 1,
        estimate_snapshot: { analysis: empty, generation: empty },
        created_at: now,
      })
      await db.insert(schema.agent_batch_items).values({
        batch_id: id,
        version: 1,
        key: 'original',
        ordinal: 0,
        kind: 'analysis',
        inputs: references,
        prompt: 'inspect',
        params: { model: config.agent.model, estimatedInputTokens: 0, evidence: [] },
        dependencies: [],
      })
    }
    const { proposeBatchAnalysis } = await import('../../lib/agent/tools/proposeBatchAnalysis')
    const tool = (phase === 'initial' ? planImageBatch : proposeBatchAnalysis).create({
      mode: 'image',
      userId: id,
      conversationId: id,
      turnId: 'turn-fixture',
      deviceId: 'fixture',
      images: createAgentImageSource({ references, history: [], conversationId: id, userId: id }),
    })
    const result = await tool.execute(
      'joint-limit',
      {
        batchId: id,
        expectedVersion: 1,
        title: '精细联合比较',
        rule: '比较两张原件之间的细微色差',
        items: [
          {
            key: 'joint',
            kind: 'analysis',
            intent: 'joint_comparison',
            imageIds: ['first', 'second'],
            prompt: '精细比较原件色差，不能使用各图摘要代替',
            dependencies: [],
          },
        ],
      },
      undefined,
      undefined,
    )
    expect(result.details).toMatchObject({
      analysisLimit: {
        reason: 'context_overflow',
        requiredImageIds: ['first', 'second'],
        jointComparisonCompleted: false,
        choices: ['select_images', 'select_regions'],
      },
    })
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: 'text', text: expect.stringContaining('尚未完成联合比较') }),
    )
    const block = toolResultBlock(
      { toolCallId: 'joint-limit', toolName: 'planImageBatch', title: '精细联合比较' },
      result,
      null,
    )
    expect(block).toMatchObject({
      analysisLimit: { requiredImageIds: ['first', 'second'], jointComparisonCompleted: false },
    })
    expect(dispatched).toBe(0)
    expect(billing.reservations).toHaveLength(0)
    expect(
      await db.select().from(schema.agent_batches).where(eq(schema.agent_batches.user_id, id)),
    ).toHaveLength(phase === 'initial' ? 0 : 1)
    expect(
      await db.select().from(schema.analysis_tasks).where(eq(schema.analysis_tasks.user_id, id)),
    ).toHaveLength(0)
  } finally {
    config.operator = operator
    config.agent = agent
  }
})

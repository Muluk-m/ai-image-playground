import { afterAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'
import { fixturePng } from '../helpers/rasterFixture'

process.env.DATABASE_URL = await resetTestDatabase('analysis_batch_comparison')
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
const { prepareAnalysisTask, quoteAnalysisTask } = await import('../../lib/analysis-tasks')
const { confirmAgentBatch, advanceAgentBatches } = await import('../../lib/agent/batch-execution')
const { runAnalysisTask } = await import('../../workers/analysis-runner')
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

it('keeps a joint comparison incomplete even when independent inspections cover every image', async () => {
  const operator = config.operator
  config.operator = {
    ...operator,
    capabilities: { ...operator.capabilities, 'agent:batch-analysis': true },
    quotas: { ...operator.quotas, 'agent:batch-dispatch-window': 2 },
  }
  const id = 'analysis-comparison-batch'
  const now = Date.now()
  try {
    billing.answer = { kind: 'reserved', credits: 7 }
    billing.settledCredits = 1
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
      .values({ id, user_id: id, title: 'compare both', created_at: now, updated_at: now })
    const references = []
    for (const [index, key] of ['first', 'second'].entries()) {
      const media = await storeMedia(
        id,
        await fixturePng(index ? '#123456' : '#abcdef'),
        'image/png',
      )
      references.push({ imageId: `image-${key}`, mediaId: media.id })
    }
    const items = []
    const snapshots = []
    for (const [ordinal, key] of ['first', 'second', 'compare'].entries()) {
      const inputs = key === 'compare' ? references : [references[ordinal]!]
      const prepared = await prepareAnalysisTask({
        userId: id,
        model: config.agent.model,
        prompt: key === 'compare' ? 'compare exact color relationship jointly' : `inspect-${key}`,
        inputs,
      })
      const quote = await db.transaction((tx) =>
        quoteAnalysisTask({
          tx,
          userId: id,
          model: prepared.model,
          estimatedInputTokens: prepared.estimatedInputTokens,
        }),
      )
      if (!quote) throw new Error('fixture quote missing')
      items.push({
        batch_id: id,
        version: 1,
        key,
        ordinal,
        kind: 'analysis' as const,
        inputs,
        prompt: prepared.prompt,
        params: {
          model: prepared.model,
          estimatedInputTokens: prepared.estimatedInputTokens,
          evidence: prepared.evidence,
          intent: key === 'compare' ? ('joint_comparison' as const) : ('inspection' as const),
        },
        dependencies: key === 'compare' ? ['first', 'second'] : [],
      })
      snapshots.push({ ...quote.pricing, itemKey: key })
    }
    await db.insert(schema.agent_batches).values({
      id,
      user_id: id,
      conversation_id: id,
      origin_turn_id: 'settled-turn',
      tool_call_id: 'analysis-plan',
      experience: 'chat',
      created_at: now,
      updated_at: now,
    })
    await db.insert(schema.agent_batch_plans).values({
      batch_id: id,
      version: 1,
      title: 'compare both',
      rule: 'inspect each then jointly compare exact color',
      digest: 'fixture-digest',
      item_count: 3,
      estimate_snapshot: {
        analysis: {
          status: 'available',
          estimatedCredits: 21,
          estimatedChargeCredits: 21,
          snapshots,
        },
        generation: {
          status: 'available',
          estimatedCredits: 0,
          estimatedChargeCredits: 0,
          snapshots: [],
        },
      },
      created_at: now,
    })
    await db.insert(schema.agent_batch_items).values(items)
    await confirmAgentBatch(id, id, {
      commandId: 'confirm',
      expectedVersion: 1,
      expectedDigest: 'fixture-digest',
      deviceId: 'fixture',
    })
    const firstAttempts = await db
      .select()
      .from(schema.agent_batch_attempts)
      .where(eq(schema.agent_batch_attempts.batch_id, id))
    expect(firstAttempts).toHaveLength(2)
    const imageCounts: number[] = []
    setChatFetchForTesting(async (_input, init) => {
      const body = JSON.parse(String(init?.body))
      imageCounts.push(
        body.messages[0].content.filter((block: { type: string }) => block.type === 'image_url')
          .length,
      )
      const prompt = String(body.messages[0].content[0].text)
      if (prompt.includes('compare exact')) throw new Error('joint comparison response unknown')
      const imageId = prompt.includes('inspect-first') ? 'image-first' : 'image-second'
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [{ imageId, text: 'independent color observation only' }],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      })
    })
    for (const attempt of firstAttempts) await runAnalysisTask(attempt.task_id)
    await advanceAgentBatches(null, () => true)
    const attempts = await db
      .select()
      .from(schema.agent_batch_attempts)
      .where(eq(schema.agent_batch_attempts.batch_id, id))
    const comparison = attempts.find((one) => one.item_key === 'compare')
    if (!comparison)
      throw new Error('joint comparison was not admitted after its dependencies completed')
    await runAnalysisTask(comparison.task_id)
    const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
    const cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession(id, tx))}`
    const { app } = await import('../../app')
    const response = await app.handle(
      new Request(`http://localhost/api/agent/batches/${id}?limit=1`, { headers: { cookie } }),
    )
    expect(response.status).toBe(200)
    const { analysisSummary } = await response.json()
    expect(analysisSummary).toMatchObject({
      complete: false,
      inspectionComplete: true,
      successfulImageIds: ['image-first', 'image-second'],
      missingImageIds: [],
      unresolvedItemKeys: ['compare'],
      jointComparisons: [
        {
          itemKey: 'compare',
          taskId: comparison.task_id,
          attempt: 1,
          status: 'reconciling',
          complete: false,
          requiredImageIds: ['image-first', 'image-second'],
        },
      ],
    })
    expect(imageCounts).toEqual([1, 1, 2])
    expect(billing.reservations).toHaveLength(3)
    expect(billing.settlements).toHaveLength(2)
  } finally {
    config.operator = operator
  }
})

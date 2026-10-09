// Intended destination: apps/bff/src/__tests__/routes/agent-batch-analysis-proposal.test.ts
import { afterAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'
import { fixturePng } from '../helpers/rasterFixture'

process.env.DATABASE_URL = await resetTestDatabase('analysis_future_source')
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
const { confirmAgentBatch } = await import('../../lib/agent/batch-execution')
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

it('never attributes a future edited attempt to an older analysis version', async () => {
  const operator = config.operator
  config.operator = {
    ...operator,
    capabilities: { ...operator.capabilities, 'agent:batch-analysis': true },
    quotas: { ...operator.quotas, 'agent:batch-dispatch-window': 2 },
  }
  const id = 'analysis-followup-version'
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
      .values({ id, user_id: id, title: 'inspect', created_at: now, updated_at: now })
    const media = await storeMedia(id, await fixturePng('#abcdef'), 'image/png')
    const inputs = [{ imageId: 'image-first', mediaId: media.id }]
    const prepared = await prepareAnalysisTask({
      userId: id,
      model: config.agent.model,
      prompt: 'inspect original colors',
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
      title: 'inspect',
      rule: 'report colors',
      digest: 'a'.repeat(64),
      item_count: 1,
      estimate_snapshot: {
        analysis: {
          status: 'available',
          estimatedCredits: 7,
          estimatedChargeCredits: 7,
          snapshots: [{ ...quote.pricing, itemKey: 'first' }],
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
    await db.insert(schema.agent_batch_items).values({
      batch_id: id,
      version: 1,
      key: 'first',
      ordinal: 0,
      kind: 'analysis',
      inputs,
      prompt: prepared.prompt,
      params: {
        model: prepared.model,
        estimatedInputTokens: prepared.estimatedInputTokens,
        evidence: prepared.evidence,
      },
      dependencies: [],
    })
    const { claimConversationMedia } = await import('../../lib/agent/images')
    expect(await claimConversationMedia(id, id, inputs)).toBe(true)
    const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
    const cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession(id, tx))}`
    const { app } = await import('../../app')
    const edited = await app.handle(
      new Request(`http://localhost/api/agent/batches/${id}`, {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: 1,
          title: 'inspect edited details',
          rule: 'look for texture',
          items: [
            {
              key: 'first',
              ordinal: 0,
              kind: 'analysis',
              inputs,
              prompt: 'inspect only fine texture in revised scope',
              params: { model: config.agent.model },
              dependencies: [],
            },
          ],
        }),
      }),
    )
    expect({ status: edited.status, body: await edited.clone().json() }).toMatchObject({
      status: 200,
    })
    const revised = await edited.json()
    expect(revised.batch.version).toBe(2)
    expect(billing.reservations).toHaveLength(0)
    await confirmAgentBatch(id, id, {
      commandId: 'confirm-edited-only',
      expectedVersion: 2,
      expectedDigest: revised.batch.digest,
      deviceId: 'fixture',
    })
    const [attempt] = await db
      .select()
      .from(schema.agent_batch_attempts)
      .where(eq(schema.agent_batch_attempts.batch_id, id))
    if (!attempt) throw new Error('revised analysis was not reserved')
    expect(attempt.version).toBe(2)
    let calls = 0
    setChatFetchForTesting(async () => {
      calls++
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [
                  { imageId: 'image-first', text: 'FUTURE-V2-ONLY: visible textured surface' },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      })
    })
    await runAnalysisTask(attempt.task_id)
    const page = await (
      await app.handle(
        new Request(`http://localhost/api/agent/batches/${id}`, { headers: { cookie } }),
      )
    ).json()
    expect(page.analysisSummary).toMatchObject({
      complete: true,
      findings: [
        {
          itemKey: 'first',
          taskId: attempt.task_id,
          text: 'FUTURE-V2-ONLY: visible textured surface',
        },
      ],
    })
    const oldCursor = Buffer.from(JSON.stringify([id, 1, 0])).toString('base64url')
    const older = await (
      await app.handle(
        new Request(`http://localhost/api/agent/batches/${id}?cursor=${oldCursor}`, {
          headers: { cookie },
        }),
      )
    ).json()
    expect(older.batch.version).toBe(1)
    expect(older.analysisSummary).toMatchObject({
      complete: false,
      findings: [],
      unresolvedItemKeys: ['first'],
    })
    const { agentTurnTools } = await import('../../lib/agent/tools')
    const { createAgentImageSource } = await import('../../lib/agent/images')
    const tool = agentTurnTools({
      mode: 'image',
      experience: 'chat',
      userId: id,
      conversationId: id,
      turnId: 'read-old-version',
      deviceId: 'fixture',
      images: createAgentImageSource({
        references: [],
        history: [],
        conversationId: id,
        userId: id,
      }),
    }).find((one) => one.name === 'readBatchAnalysis')
    if (!tool) throw new Error('analysis read tool missing')
    const result = await tool.execute(
      'read-old-version',
      { batchId: id, version: 1, offset: 0, limit: 20 },
      undefined,
      undefined,
    )
    const text = result.content.find((content) => content.type === 'text')
    if (!text || text.type !== 'text') throw new Error('analysis read result missing')
    expect(JSON.parse(text.text)).toMatchObject({
      version: 1,
      complete: false,
      findings: [],
      total: 0,
    })
    expect(calls).toBe(1)
    expect(billing.reservations).toHaveLength(1)
    expect(billing.settlements).toHaveLength(1)
  } finally {
    config.operator = operator
  }
})

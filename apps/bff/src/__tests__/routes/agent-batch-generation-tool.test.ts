import { afterAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'
import { fixturePng } from '../helpers/rasterFixture'

process.env.DATABASE_URL = await resetTestDatabase('analysis_generation_tool')
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
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
setObjectStoreForTesting(new InMemoryObjectStore())
setDurableMediaStoreForTesting(
  Object.assign(new InMemoryObjectStore(), { sign: (key: string) => `http://media.test/${key}` }),
)
afterAll(async () => {
  setObjectStoreForTesting()
  setChatFetchForTesting()
  setDurableMediaStoreForTesting()
  _setPrivateBffOverlayForTesting()
  await close()
})

it('lets the Agent propose concrete generation from real analysis without reserving before user confirmation', async () => {
  const operator = config.operator
  config.operator = {
    ...operator,
    capabilities: { ...operator.capabilities, 'agent:batch-analysis': true },
    quotas: { ...operator.quotas, 'agent:batch-dispatch-window': 2 },
  }
  const id = 'analysis-generation-stages'
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
      .values({ id, user_id: id, title: 'inspect both', created_at: now, updated_at: now })
    const items = []
    const snapshots = []
    for (const [ordinal, key] of ['first'].entries()) {
      const media = await storeMedia(
        id,
        await fixturePng(ordinal ? '#123456' : '#abcdef'),
        'image/png',
      )
      const prepared = await prepareAnalysisTask({
        userId: id,
        model: config.agent.model,
        prompt: `inspect-${key}`,
        inputs: [{ imageId: `image-${key}`, mediaId: media.id }],
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
        inputs: prepared.inputs,
        prompt: prepared.prompt,
        params: {
          model: prepared.model,
          estimatedInputTokens: prepared.estimatedInputTokens,
          evidence: prepared.evidence,
        },
        dependencies: [],
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
      title: 'inspect both',
      rule: 'report each image',
      digest: 'a'.repeat(64),
      item_count: 1,
      estimate_snapshot: {
        analysis: {
          status: 'available',
          estimatedCredits: 7,
          estimatedChargeCredits: 7,
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
    const { claimConversationMedia } = await import('../../lib/agent/images')
    expect(
      await claimConversationMedia(
        id,
        id,
        items.flatMap((item) => item.inputs),
      ),
    ).toBe(true)
    await confirmAgentBatch(id, id, {
      commandId: 'confirm',
      expectedVersion: 1,
      expectedDigest: 'a'.repeat(64),
      deviceId: 'fixture',
    })
    const attempts = await db
      .select()
      .from(schema.agent_batch_attempts)
      .where(eq(schema.agent_batch_attempts.batch_id, id))
    expect(attempts).toHaveLength(1)
    let calls = 0
    setChatFetchForTesting(async (_input, init) => {
      calls++
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [{ imageId: 'image-first', text: 'first image has uniform color' }],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      })
    })
    for (const attempt of attempts) await runAnalysisTask(attempt.task_id)
    const originalAnalysis = await db
      .select()
      .from(schema.analysis_tasks)
      .where(eq(schema.analysis_tasks.batch_id, id))
    const { TEST_IMAGE_CHANNEL } = await import('../helpers/agentStubs')
    const { _setChannelsForTesting } = await import('../../lib/channels')
    _setChannelsForTesting([TEST_IMAGE_CHANNEL])
    const current = await loadPrivateBffOverlay()
    _setPrivateBffOverlayForTesting({
      ...current,
      taskHooks: {
        ...current.taskHooks,
        async quoteTask({ model, quantity, unitMultiplier }) {
          return {
            estimatedCredits: 7,
            pricing: {
              model,
              unit: 'image',
              quantity,
              unitMultiplier,
              baseUnitCredits: 7,
              outputPriceRatio: 0,
              cachedInputPriceRatio: 0,
              inputEstimateTokens: 0,
              outputReserveTokens: 0,
              exemption: 'none',
              pricingVersion: 'generation-v1',
              quotedAt: 1,
              validUntil: null,
            },
          }
        },
      },
    })
    const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
    const cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession(id, tx))}`
    const { app } = await import('../../app')
    const request = (suffix: string, body: unknown) =>
      app.handle(
        new Request(`http://localhost/api/agent/batches/${id}${suffix}`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )
    const prompt = '已检查：原图颜色均匀。保持原件主体颜色，将背景换成纯白。'
    const { agentTurnTools } = await import('../../lib/agent/tools')
    const { createAgentImageSource } = await import('../../lib/agent/images')
    const tool = agentTurnTools({
      mode: 'image',
      experience: 'chat',
      userId: id,
      conversationId: id,
      turnId: 'review-turn',
      deviceId: 'fixture',
      params: { model: 'gpt-image-2.5-flare' },
      images: createAgentImageSource({
        references: items.flatMap((item) => item.inputs),
        history: [],
        conversationId: id,
        userId: id,
      }),
    }).find((one) => one.name === 'proposeBatchGeneration')
    expect(tool).toBeDefined()
    if (!tool) throw new Error('Agent generation proposal tool missing')
    const result = await tool.execute(
      'propose-generation-from-findings',
      {
        batchId: id,
        expectedVersion: 1,
        items: [
          {
            key: 'white-background',
            inputImageIds: ['image-first'],
            sourceItemKeys: ['first'],
            prompt,
          },
        ],
      },
      undefined,
      undefined,
    )
    expect(result.details).toMatchObject({ batchId: id })
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: 'text', text: expect.stringContaining('确认生成') }),
    )
    const page = await (
      await app.handle(
        new Request(`http://localhost/api/agent/batches/${id}`, { headers: { cookie } }),
      )
    ).json()
    const proposed = page.items.find((item: { key: string }) => item.key === 'white-background')
    expect(page.batch).toMatchObject({
      version: 2,
      confirmationRequired: true,
      estimate: {
        analysis: { estimatedChargeCredits: 0 },
        generation: { estimatedChargeCredits: 7 },
      },
    })
    expect(proposed).toMatchObject({
      kind: 'generation',
      prompt,
      sourceAnalysis: [{ itemKey: 'first', taskId: attempts[0]!.task_id, attempt: 1 }],
    })
    expect(proposed.execution).toBeUndefined()
    expect(billing.reservations).toHaveLength(1)
    expect(calls).toBe(1)
    expect(await db.select().from(schema.tasks).where(eq(schema.tasks.kind, 'queue'))).toHaveLength(
      0,
    )
    const confirmation = {
      commandId: 'confirm-generation-v2',
      expectedVersion: 2,
      expectedDigest: page.batch.digest,
      deviceId: 'fixture',
    }
    const confirmed = await request('/confirm', confirmation)
    expect({ status: confirmed.status, body: await confirmed.json() }).toMatchObject({
      status: 200,
    })
    expect((await request('/confirm', confirmation)).status).toBe(200)
    const [generation] = await db.select().from(schema.tasks).where(eq(schema.tasks.kind, 'queue'))
    if (!generation) throw new Error('generation confirmation did not create its task')
    expect(billing.reservations).toHaveLength(2)
    const { setUpstreamFetchForTesting } = await import('../../lib/upstream')
    const output = await fixturePng('#ffffff')
    let generationCalls = 0
    setUpstreamFetchForTesting(async () => {
      generationCalls++
      return Response.json({ data: [{ b64_json: Buffer.from(output).toString('base64') }] })
    })
    const { runTask } = await import('../../workers/task-runner')
    try {
      await runTask(generation.id)
    } finally {
      setUpstreamFetchForTesting()
      setObjectStoreForTesting()
    }
    expect(generationCalls).toBe(1)
    expect(
      (await db.select().from(schema.tasks).where(eq(schema.tasks.id, generation.id)))[0]?.status,
    ).toBe('completed')
    expect(
      await db.select().from(schema.analysis_tasks).where(eq(schema.analysis_tasks.batch_id, id)),
    ).toEqual(originalAnalysis)
    expect(billing.reservations.filter((one) => one.taskId === generation.id)).toHaveLength(1)
    expect(billing.settlements.filter((one) => one.taskId === attempts[0]!.task_id)).toHaveLength(1)
    expect(calls).toBe(1)
  } finally {
    config.operator = operator
  }
})

// Intended destination: apps/bff/src/__tests__/routes/agent-batch-generation-proposal.test.ts
import { afterAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'
import { fixturePng } from '../helpers/rasterFixture'

process.env.DATABASE_URL = await resetTestDatabase('analysis_hundred_followup')
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

it('adds a paid inspection after 100 originals and generates from explicitly retained source versions', async () => {
  const operator = config.operator
  config.operator = {
    ...operator,
    capabilities: { ...operator.capabilities, 'agent:batch-analysis': true },
    quotas: { ...operator.quotas, 'agent:batch-max-items': 100, 'agent:batch-dispatch-window': 2 },
  }
  const id = 'hundred-stage-owner'
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
      .values({ id, user_id: id, title: '100 inspections', created_at: now, updated_at: now })
    const items = []
    const snapshots = []
    for (let ordinal = 0; ordinal < 100; ordinal++) {
      const key = `inspect-${ordinal}`
      const media = await storeMedia(
        id,
        await fixturePng(`#${ordinal.toString(16).padStart(6, '0')}`),
        'image/png',
      )
      const prepared = await prepareAnalysisTask({
        userId: id,
        model: config.agent.model,
        prompt: `inspect original ${ordinal}`,
        inputs: [{ imageId: `image-${ordinal}`, mediaId: media.id }],
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
      title: '100 inspections',
      rule: 'inspect each then generate from concrete findings',
      digest: 'a'.repeat(64),
      item_count: 100,
      estimate_snapshot: {
        analysis: {
          status: 'available',
          estimatedCredits: 700,
          estimatedChargeCredits: 700,
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
    const { advanceAgentBatches } = await import('../../lib/agent/batch-execution')
    let calls = 0
    setChatFetchForTesting(async (_input, init) => {
      calls++
      const prompt = String(JSON.parse(String(init?.body)).messages[0].content[0].text)
      const ordinal = /inspect original (\d+)/.exec(prompt)?.[1]
      if (!ordinal) throw new Error('fixture lost the original identity')
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [{ imageId: `image-${ordinal}`, text: `observed original ${ordinal}` }],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      })
    })
    await confirmAgentBatch(id, id, {
      commandId: 'confirm-analysis-100',
      expectedVersion: 1,
      expectedDigest: 'a'.repeat(64),
      deviceId: 'fixture',
    })
    for (let window = 0; window < 50; window++) {
      const queued = await db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(eq(schema.tasks.status, 'queued'))
      expect(queued).toHaveLength(2)
      for (const task of queued) await runAnalysisTask(task.id)
      await advanceAgentBatches(null, () => true)
    }
    expect(calls).toBe(100)
    expect(billing.reservations).toHaveLength(100)
    expect(billing.settlements).toHaveLength(100)
    const previous = await db
      .select()
      .from(schema.analysis_tasks)
      .where(eq(schema.analysis_tasks.batch_id, id))
    expect(previous.every((task) => task.status === 'completed')).toBe(true)
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
    const proposal = await request('/analysis-proposal', {
      commandId: 'detail-after-100',
      expectedVersion: 1,
      items: [
        {
          key: 'detail-zero',
          inputs: items[0]!.inputs,
          prompt: 'inspect fine texture of original 0',
          dependencies: ['inspect-0'],
          params: { model: config.agent.model, intent: 'inspection' },
        },
      ],
    })
    expect({ status: proposal.status, body: await proposal.clone().json() }).toMatchObject({
      status: 200,
    })
    const page = await proposal.json()
    expect(page.batch).toMatchObject({
      version: 2,
      itemCount: 1,
      confirmationRequired: true,
      confirmation: { phase: 'analysis', itemKeys: ['detail-zero'], sourceVersions: [1] },
      estimate: { analysis: { estimatedChargeCredits: 7 } },
    })
    expect(page.items).toHaveLength(1)
    expect(page.sourceAnalysisSummary.successfulImageIds).toHaveLength(100)
    expect(billing.reservations).toHaveLength(100)
    const currentTasks = await db
      .select()
      .from(schema.analysis_tasks)
      .where(eq(schema.analysis_tasks.batch_id, id))
    expect(currentTasks).toEqual(previous)
    const confirming = {
      commandId: 'confirm-detail',
      expectedVersion: 2,
      expectedDigest: page.batch.digest,
      deviceId: 'fixture',
    }
    expect((await request('/confirm', confirming)).status).toBe(200)
    expect((await request('/confirm', confirming)).status).toBe(200)
    const [followup] = (
      await db.select().from(schema.analysis_tasks).where(eq(schema.analysis_tasks.batch_id, id))
    ).filter((task) => task.item_key === 'detail-zero')
    if (!followup) throw new Error('supplemental analysis was not independently reserved')
    setChatFetchForTesting(async () => {
      calls++
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [{ imageId: 'image-0', text: 'observed fine texture original 0' }],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      })
    })
    await runAnalysisTask(followup.task_id)
    await advanceAgentBatches(null, () => true)
    expect(calls).toBe(101)
    expect(billing.reservations).toHaveLength(101)
    expect(billing.settlements).toHaveLength(101)
    const generationItems = items.map((item) => ({
      key: `generate-${item.ordinal}`,
      inputImageIds: [`image-${item.ordinal}`],
      sourceItemKeys: [item.ordinal === 0 ? 'detail-zero' : item.key],
      prompt: `Based on observed original ${item.ordinal}, preserve the subject and make background white.`,
      params: { model: 'gpt-image-2.5-flare', provider: 'openai-compat' },
    }))
    const generationBody = {
      commandId: 'generate-from-two-source-versions',
      expectedVersion: 2,
      sourceVersions: [1, 2],
      excludedItemKeys: ['inspect-0'],
      items: generationItems,
    }
    expect(
      (
        await request('/generation-proposal', {
          ...generationBody,
          commandId: 'forged-source-version',
          sourceVersions: [1, 999],
        })
      ).status,
    ).toBe(409)
    const generation = await request('/generation-proposal', generationBody)
    expect({ status: generation.status, body: await generation.clone().json() }).toMatchObject({
      status: 200,
    })
    const generated = await generation.json()
    expect(generated.batch).toMatchObject({
      version: 3,
      itemCount: 100,
      confirmationRequired: true,
      confirmation: {
        phase: 'generation',
        sourceVersions: [1, 2],
        excludedItemKeys: ['inspect-0'],
      },
      estimate: {
        analysis: { estimatedChargeCredits: 0 },
        generation: { estimatedChargeCredits: 700 },
      },
    })
    expect(generated.items[0].sourceAnalysis).toMatchObject([
      { itemKey: 'detail-zero', taskId: followup.task_id, attempt: 1, version: 2 },
    ])
    expect(generated.items[99].sourceAnalysis).toMatchObject([
      {
        itemKey: 'inspect-99',
        taskId: previous.find((task) => task.item_key === 'inspect-99')!.task_id,
        attempt: 1,
        version: 1,
      },
    ])
    expect(billing.reservations).toHaveLength(101)
    expect(
      (
        await request('/confirm', {
          commandId: 'confirm-generation-100',
          expectedVersion: 3,
          expectedDigest: generated.batch.digest,
          deviceId: 'fixture',
        })
      ).status,
    ).toBe(200)
    expect(billing.reservations).toHaveLength(103)
    expect(await db.select().from(schema.tasks).where(eq(schema.tasks.kind, 'queue'))).toHaveLength(
      2,
    )
    expect(
      (
        await db.select().from(schema.analysis_tasks).where(eq(schema.analysis_tasks.batch_id, id))
      ).filter((task) => task.item_key !== 'detail-zero'),
    ).toEqual(previous)
    expect(
      (
        await db
          .select()
          .from(schema.agent_batch_items)
          .where(eq(schema.agent_batch_items.batch_id, id))
      ).filter((item) => item.version === 1),
    ).toHaveLength(100)
  } finally {
    config.operator = operator
  }
}, 120_000)

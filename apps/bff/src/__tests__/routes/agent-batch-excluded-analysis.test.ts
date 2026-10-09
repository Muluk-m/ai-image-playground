// Intended destination: apps/bff/src/__tests__/routes/agent-batch-analysis-summary.test.ts
import { afterAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'
import { fixturePng } from '../helpers/rasterFixture'

process.env.DATABASE_URL = await resetTestDatabase('analysis_excluded_unknown')
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

it('requires explicit exclusions and keeps an excluded unknown analysis open after generation finishes', async () => {
  const operator = config.operator
  config.operator = {
    ...operator,
    capabilities: { ...operator.capabilities, 'agent:batch-analysis': true },
    quotas: { ...operator.quotas, 'agent:batch-dispatch-window': 2 },
  }
  const id = 'analysis-coverage-batch'
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
    for (const [ordinal, key] of ['first', 'second'].entries()) {
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
      item_count: 2,
      estimate_snapshot: {
        analysis: {
          status: 'available',
          estimatedCredits: 14,
          estimatedChargeCredits: 14,
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
    expect(attempts).toHaveLength(2)
    let calls = 0
    setChatFetchForTesting(async (_input, init) => {
      calls++
      if (String(init?.body).includes('inspect-second'))
        throw new Error('accepted response disconnected')
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
    const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
    const cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession(id, tx))}`
    const { app } = await import('../../app')
    const read = () =>
      app.handle(
        new Request(`http://localhost/api/agent/batches/${id}?limit=1`, { headers: { cookie } }),
      )
    const response = await read()
    expect(response.status).toBe(200)
    const page = await response.json()
    expect(page.analysisSummary).toMatchObject({
      complete: false,
      requiredImageIds: ['image-first', 'image-second'],
      successfulImageIds: ['image-first'],
      missingImageIds: ['image-second'],
      unresolvedItemKeys: ['second'],
    })
    expect(page.analysisSummary.findings).toEqual([
      expect.objectContaining({
        imageId: 'image-first',
        text: 'first image has uniform color',
        itemKey: 'first',
        attempt: 1,
        taskId: attempts.find((one) => one.item_key === 'first')!.task_id,
        evidence: [expect.objectContaining({ imageId: 'image-first', representation: 'preview' })],
      }),
    ])
    const unknown = attempts.find((attempt) => attempt.item_key === 'second')!
    const originalUnknown = (
      await db
        .select()
        .from(schema.analysis_tasks)
        .where(eq(schema.analysis_tasks.task_id, unknown.task_id))
    )[0]
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
    const request = (suffix: string, body: unknown) =>
      app.handle(
        new Request(`http://localhost/api/agent/batches/${id}${suffix}`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )
    const proposedItems = [
      {
        key: 'generate-first',
        inputImageIds: ['image-first'],
        sourceItemKeys: ['first'],
        prompt:
          'Based on the observed uniform original color, keep subject and make background white.',
        params: { model: 'gpt-image-2.5-flare', provider: 'openai-compat' },
      },
    ]
    const silent = await request('/generation-proposal', {
      commandId: 'silently-drop-unknown',
      expectedVersion: 1,
      items: proposedItems,
    })
    expect(silent.status).toBe(409)
    expect(await silent.json()).toEqual({ error: 'batch_scope_reduction_required' })
    const proposal = await request('/generation-proposal', {
      commandId: 'explicitly-exclude-unknown',
      expectedVersion: 1,
      excludedItemKeys: ['second'],
      excludedImageIds: ['image-second'],
      items: proposedItems,
    })
    expect(proposal.status).toBe(200)
    const next = await proposal.json()
    expect(next.batch.confirmation).toMatchObject({
      phase: 'generation',
      sourceVersion: 1,
      excludedItemKeys: ['second'],
      excludedImageIds: ['image-second'],
    })
    expect(next.sourceAnalysisSummary).toMatchObject({
      complete: false,
      unresolvedItemKeys: ['second'],
      missingImageIds: ['image-second'],
    })
    expect(
      (
        await request('/confirm', {
          commandId: 'confirm-selected-generation',
          expectedVersion: 2,
          expectedDigest: next.batch.digest,
          deviceId: 'fixture',
        })
      ).status,
    ).toBe(200)
    const [generation] = await db.select().from(schema.tasks).where(eq(schema.tasks.kind, 'queue'))
    if (!generation) throw new Error('explicitly selected generation was not admitted')
    const { setUpstreamFetchForTesting } = await import('../../lib/upstream')
    const output = await fixturePng('#ffffff')
    setUpstreamFetchForTesting(async () =>
      Response.json({ data: [{ b64_json: Buffer.from(output).toString('base64') }] }),
    )
    const { runTask } = await import('../../workers/task-runner')
    try {
      await runTask(generation.id)
    } finally {
      setUpstreamFetchForTesting()
      setObjectStoreForTesting()
    }
    const finished = await (await read()).json()
    expect(finished.items[0].execution.status).toBe('completed')
    expect(finished.batch.status).not.toBe('closed')
    expect(finished.sourceAnalysisSummary).toMatchObject({
      complete: false,
      unresolvedItemKeys: ['second'],
    })
    expect(
      (
        await db
          .select()
          .from(schema.analysis_tasks)
          .where(eq(schema.analysis_tasks.task_id, unknown.task_id))
      )[0],
    ).toEqual(originalUnknown)
    expect(billing.reservations).toHaveLength(3)
    expect(billing.settlements).toHaveLength(2)
    expect(billing.settlements.filter((one) => one.taskId === unknown.task_id)).toHaveLength(0)
    expect(
      (
        await db
          .select()
          .from(schema.media_references)
          .where(eq(schema.media_references.owner_id, unknown.task_id))
      ).length,
    ).toBeGreaterThan(0)
    expect(
      (
        await db.select().from(schema.agent_inbox).where(eq(schema.agent_inbox.conversation_id, id))
      ).filter((row) => row.kind === 'task_result'),
    ).toHaveLength(0)
    expect(calls).toBe(2)
  } finally {
    config.operator = operator
  }
})

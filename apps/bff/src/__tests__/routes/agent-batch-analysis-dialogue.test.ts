import { afterAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'
import { fixturePng } from '../helpers/rasterFixture'

process.env.DATABASE_URL = await resetTestDatabase('analysis_read_dialogue')
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

it('reads actual analysis in bounded pages through a real Agent turn before proposing generation', async () => {
  const operator = config.operator
  config.operator = {
    ...operator,
    capabilities: { ...operator.capabilities, 'agent:batch-analysis': true },
    quotas: { ...operator.quotas, 'agent:batch-dispatch-window': 2 },
  }
  const id = '10000000-0000-4000-8000-000000000071'
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
      deviceId: 'device-fixture',
    })
    const attempts = await db
      .select()
      .from(schema.agent_batch_attempts)
      .where(eq(schema.agent_batch_attempts.batch_id, id))
    expect(attempts).toHaveLength(2)
    let calls = 0
    setChatFetchForTesting(async (_input, init) => {
      calls++
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [
                  {
                    imageId: calls === 1 ? 'image-first' : 'image-second',
                    text: 'OBSERVED-CYAN-731: first image has cyan stripes',
                  },
                ],
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
    const { reconcileAgentBatchProgress } = await import('../../lib/agent/batch-progress')
    await reconcileAgentBatchProgress(id)
    const { batchWakeSummary } = await import('../../lib/agent/batch-wake')
    const wake = await batchWakeSummary(
      id,
      { kind: 'user', userId: id },
      { batchId: id, version: 1, eventVersion: 1, itemKeys: ['first', 'second'] },
    )
    expect(wake).toContain('readBatchAnalysis')
    expect(wake).not.toContain('OBSERVED-CYAN-731')
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
    const { silenceChatUpstream } = await import('../helpers/chatStubs')
    await silenceChatUpstream()
    const { setAgentFetchForTesting } = await import('../../lib/agent/model')
    const { scriptedAgentFetch, toolCallCompletion, completionStream, parseFrames, eventsOfType } =
      await import('../helpers/agentStubs')
    const dialogue: import('../helpers/agentStubs').AgentCall[] = []
    let nextOffset = 0
    let concretePrompt = ''
    const toolPayload = () => {
      const messages = dialogue.at(-1)?.messages.filter((message) => message.role === 'tool') ?? []
      const last = messages.at(-1)
      if (!last) throw new Error('readBatchAnalysis did not return a tool message')
      const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
      return JSON.parse(content)
    }
    setAgentFetchForTesting(
      scriptedAgentFetch(dialogue, [
        () =>
          toolCallCompletion({
            id: 'read-analysis-page-1',
            name: 'readBatchAnalysis',
            args: { batchId: id, version: 1, offset: 0, limit: 1 },
          }),
        () => {
          const read = toolPayload()
          expect(read).toMatchObject({
            batchId: id,
            version: 1,
            offset: 0,
            nextOffset: 1,
            total: 2,
          })
          expect(read.findings).toHaveLength(1)
          expect(read.findings[0]).toMatchObject({
            itemKey: 'first',
            taskId: attempts.find((one) => one.item_key === 'first')!.task_id,
            attempt: 1,
            imageId: 'image-first',
            text: expect.stringContaining('OBSERVED-CYAN-731'),
          })
          expect(read.findings[0].evidence).toHaveLength(1)
          expect(
            billing.reservations.filter((one) =>
              attempts.some((attempt) => attempt.task_id === one.taskId),
            ),
          ).toHaveLength(2)
          nextOffset = read.nextOffset
          concretePrompt = `Preserve the observed fact: ${read.findings[0].text}. Change only the background to white.`
          return toolCallCompletion({
            id: 'read-analysis-page-2',
            name: 'readBatchAnalysis',
            args: { batchId: id, version: 1, offset: nextOffset, limit: 1 },
          })
        },
        () => {
          const read = toolPayload()
          expect(read).toMatchObject({ offset: 1, nextOffset: null, total: 2 })
          expect(read.findings).toHaveLength(1)
          expect(read.findings[0]).toMatchObject({ itemKey: 'second', imageId: 'image-second' })
          return toolCallCompletion({
            id: 'propose-read-generation',
            name: 'proposeBatchGeneration',
            args: {
              batchId: id,
              expectedVersion: 1,
              items: [
                {
                  key: 'white-background',
                  inputImageIds: ['image-first', 'image-second'],
                  sourceItemKeys: ['first', 'second'],
                  prompt: concretePrompt,
                },
              ],
            },
          })
        },
        () => completionStream('已按真实观察拟定白底计划，请确认生成。'),
      ]),
    )
    let response: Response
    try {
      response = await app.handle(
        new Request(`http://localhost/api/agent/conversations/${id}/turns`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({
            deviceId: 'device-fixture',
            text: '读取这批分析结果，按真实观察给两张图拟定白底生成计划。',
            params: { model: 'gpt-image-2.5-flare' },
          }),
        }),
      )
      if (response.status !== 200)
        throw new Error(`Agent turn rejected: ${response.status} ${await response.text()}`)
      expect(response.status).toBe(200)
      const frames = parseFrames(await response.text())
      expect(eventsOfType(frames, 'turnEnd')[0]).toMatchObject({ stopReason: 'completed' })
    } finally {
      setAgentFetchForTesting()
    }
    expect(dialogue[0]?.tools?.some((tool) => tool.function.name === 'readBatchAnalysis')).toBe(
      true,
    )
    expect(dialogue).toHaveLength(4)
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
      prompt: concretePrompt,
      sourceAnalysis: [
        {
          itemKey: 'first',
          taskId: attempts.find((one) => one.item_key === 'first')!.task_id,
          attempt: 1,
        },
        {
          itemKey: 'second',
          taskId: attempts.find((one) => one.item_key === 'second')!.task_id,
          attempt: 1,
        },
      ],
    })
    expect(proposed.execution).toBeUndefined()
    expect(billing.reservations.filter((one) => one.model !== config.agent.model)).toHaveLength(0)
    expect(calls).toBe(2)
    expect(await db.select().from(schema.tasks).where(eq(schema.tasks.kind, 'queue'))).toHaveLength(
      0,
    )
    expect(
      await db.select().from(schema.analysis_tasks).where(eq(schema.analysis_tasks.batch_id, id)),
    ).toEqual(originalAnalysis)
    expect(billing.reservations.filter((one) => one.model === 'gpt-image-2.5-flare')).toHaveLength(
      0,
    )
  } finally {
    config.operator = operator
  }
})

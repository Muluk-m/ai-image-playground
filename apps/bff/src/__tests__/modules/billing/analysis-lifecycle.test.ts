import { afterAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { creditLedger, modelPrices, taskHolds } from '@image-playground/db/billing'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq, sql } from 'drizzle-orm'
import { InMemoryObjectStore } from '../../helpers/inMemoryObjectStore'
import { fixturePng } from '../../helpers/rasterFixture'

const databaseUrl = await resetTestDatabase('analysis_restart_billing')
process.env.DATABASE_URL = databaseUrl
process.env.PORT = '0'
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-key'
process.env.INTERNAL_API_TOKEN = 'analysis-reconcile-token'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, 'operator-config-chat.json')
process.env.WELCOME_CREDITS = '100000'
const { ensureBillingMigrations } = await import('@image-playground/db')
await ensureBillingMigrations(databaseUrl)
const { db, schema, close } = await import('../../../db/client')
const { config } = await import('../../../config')
const { privateTaskHooks, getChatPricing, getChatUsageSummary, getLedgerPage } = await import(
  '../../../modules/billing/service'
)
const { EMPTY_PRIVATE_BFF_OVERLAY, _setPrivateBffOverlayForTesting } = await import(
  '../../../lib/private-overlay'
)
_setPrivateBffOverlayForTesting({
  ...EMPTY_PRIVATE_BFF_OVERLAY,
  present: true,
  taskHooks: privateTaskHooks,
})
const { reserveChatTask } = await import('../../../lib/agent/chat-task')
const { prepareAnalysisTask, reserveAnalysisTask, finalizeAnalysisTask, recoverAnalysisTasks } =
  await import('../../../lib/analysis-tasks')
const { runAnalysisTask } = await import('../../../workers/analysis-runner')
const { setChatFetchForTesting } = await import('../../../lib/chatCompletion')
const { setDurableMediaStoreForTesting } = await import('../../../lib/durableMediaStore')
const { storeMedia } = await import('../../../lib/projectMedia')
const store = Object.assign(new InMemoryObjectStore(), {
  sign: (key: string) => `http://media.test/${key}`,
})
setDurableMediaStoreForTesting(store)
afterAll(async () => {
  setChatFetchForTesting()
  setDurableMediaStoreForTesting()
  _setPrivateBffOverlayForTesting()
  await close()
})

it('recovers an independent analysis after response persistence without changing a settled chat or publishing generation media', async () => {
  const userId = 'analysis-owner'
  const model = 'analysis-model'
  const taskId = 'analysis-task'
  const conversationId = 'old-conversation'
  const turnId = 'settled-turn'
  const now = Date.now()
  await db.insert(schema.users).values({
    id: userId,
    username: userId,
    password_hash: 'fixture',
    created_at: now,
    updated_at: now,
  })
  await db.insert(modelPrices).values({
    model,
    credits_per_image: 6,
    unit: 'kilo_token',
    output_credits_per_unit: 30,
    output_reserve_tokens: 1500,
    cached_input_price_percent: 10,
    active: true,
    updated_at: now,
  })
  const pricing = (await getChatPricing(model))!
  const old = await db.transaction((tx) =>
    reserveChatTask({
      tx,
      taskHooks: privateTaskHooks,
      conversationId,
      turnId,
      userId,
      deviceId: 'analysis-device',
      model,
      estimatedInputTokens: 1000,
      pricing,
    }),
  )
  if (old.kind !== 'reserved') throw new Error('fixture chat reservation refused')
  await old.settle({
    outcome: 'completed',
    usage: { inputTokens: 100, outputTokens: 20 },
    upstreamInvocationCount: 1,
  })
  const oldChatUsage = await getChatUsageSummary(userId)
  const oldTask = await db.select().from(schema.tasks).where(eq(schema.tasks.id, turnId))
  const oldLedger = await db
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.task_id, turnId))
    .orderBy(creditLedger.id)
  const oldHold = await db.select().from(taskHolds).where(eq(taskHolds.task_id, turnId))
  const image = await storeMedia(userId, await fixturePng('#abcdef'), 'image/png')
  const prepared = await prepareAnalysisTask({
    userId,
    model,
    prompt: '检查颜色',
    inputs: [{ imageId: 'image-1', mediaId: image.id }],
  })
  await db.transaction(async (tx) => {
    const quote = await privateTaskHooks.quoteTokenTask!({
      tx,
      userId,
      model,
      estimatedInputTokens: prepared.estimatedInputTokens,
    })
    if (!quote) throw new Error('fixture analysis quote unavailable')
    expect(
      await reserveAnalysisTask({
        tx,
        taskHooks: privateTaskHooks,
        taskId,
        userId,
        deviceId: 'analysis-device',
        batchId: 'approved-batch',
        version: 1,
        itemKey: 'inspect-1',
        attempt: 1,
        originConversationId: conversationId,
        originTurnId: turnId,
        prepared,
        pricing: quote.pricing,
      }),
    ).toMatchObject({ kind: 'reserved' })
  })
  expect((await db.select().from(taskHolds).where(eq(taskHolds.task_id, taskId)))[0]?.status).toBe(
    'held',
  )
  const keys = [...store.objects.keys()].sort()
  let calls = 0
  setChatFetchForTesting(async () => {
    calls++
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({ findings: [{ imageId: 'image-1', text: '颜色均匀' }] }),
          },
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    })
  })
  await db.execute(
    sql`CREATE FUNCTION interrupt_analysis_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture interrupted analysis finalize'; END $$`,
  )
  await db.execute(
    sql`CREATE TRIGGER interrupt_analysis_finish BEFORE UPDATE ON tasks FOR EACH ROW WHEN (NEW.kind = 'analysis' AND NEW.status = 'completed') EXECUTE FUNCTION interrupt_analysis_finish()`,
  )
  try {
    await expect(runAnalysisTask(taskId)).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining('fixture interrupted analysis finalize'),
      }),
    })
    expect(calls).toBe(1)
    expect(
      (await db.select().from(taskHolds).where(eq(taskHolds.task_id, taskId)))[0]?.status,
    ).toBe('held')
  } finally {
    await db.execute(sql`DROP TRIGGER interrupt_analysis_finish ON tasks`)
    await db.execute(sql`DROP FUNCTION interrupt_analysis_finish()`)
  }
  await db
    .update(schema.tasks)
    .set({ lease_expires_at: Date.now() - 10_000 })
    .where(eq(schema.tasks.id, taskId))
  await recoverAnalysisTasks()
  expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)))[0]?.status).toBe(
    'queued',
  )
  await runAnalysisTask(taskId)
  await finalizeAnalysisTask(taskId, 'stale-finalize-token')
  expect(calls).toBe(1)
  expect(
    (await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)))[0],
  ).toMatchObject({ kind: 'analysis', status: 'completed', agent_turn_id: null })
  const result = await db.execute(
    sql`SELECT findings, coverage, evidence FROM analysis_tasks WHERE task_id = ${taskId}`,
  )
  expect(result[0]).toMatchObject({
    findings: [{ imageId: 'image-1', text: '颜色均匀' }],
    coverage: { requiredImageIds: ['image-1'], reviewedImageIds: ['image-1'], missingImageIds: [] },
  })
  expect(result[0]?.evidence).toMatchObject([{ imageId: 'image-1', width: 8, height: 6 }])
  expect((await db.select().from(taskHolds).where(eq(taskHolds.task_id, taskId)))[0]).toMatchObject(
    {
      status: 'committed',
      net_spend: 1,
      input_tokens: 100,
      cached_input_tokens: 80,
      output_tokens: 20,
    },
  )
  expect(await db.select().from(schema.tasks).where(eq(schema.tasks.id, turnId))).toEqual(oldTask)
  expect(
    await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.task_id, turnId))
      .orderBy(creditLedger.id),
  ).toEqual(oldLedger)
  expect(await db.select().from(taskHolds).where(eq(taskHolds.task_id, turnId))).toEqual(oldHold)
  expect(await db.select().from(schema.generation_records)).toHaveLength(0)
  expect(await db.select().from(schema.project_generation_outputs)).toHaveLength(0)
  expect([...store.objects.keys()].sort()).toEqual(keys)
  expect(await getChatUsageSummary(userId)).toEqual(oldChatUsage)
  await db.delete(schema.tasks).where(eq(schema.tasks.id, taskId))
  expect(await getChatUsageSummary(userId)).toEqual(oldChatUsage)
  const entries = (await getLedgerPage(userId, 0, 100)).ledger.filter(
    (entry) => entry.task_id === taskId,
  )
  expect(entries.length).toBeGreaterThan(0)
  expect(entries).toEqual(
    expect.arrayContaining([expect.objectContaining({ task_kind: 'analysis' })]),
  )
})

async function reserveIndependentFixture(id: string, prompt = 'inspect') {
  const now = Date.now()
  await db
    .insert(schema.users)
    .values({ id, username: id, password_hash: 'fixture', created_at: now, updated_at: now })
  await db.insert(modelPrices).values({
    model: id,
    credits_per_image: 6,
    unit: 'kilo_token',
    output_credits_per_unit: 30,
    output_reserve_tokens: 1500,
    cached_input_price_percent: 10,
    active: true,
    updated_at: now,
  })
  const media = await storeMedia(id, await fixturePng('#abcdef'), 'image/png')
  const prepared = await prepareAnalysisTask({
    userId: id,
    model: id,
    prompt,
    inputs: [{ imageId: 'image-1', mediaId: media.id }],
  })
  await db.transaction(async (tx) => {
    const quote = await privateTaskHooks.quoteTokenTask!({
      tx,
      userId: id,
      model: id,
      estimatedInputTokens: prepared.estimatedInputTokens,
    })
    if (!quote) throw new Error('fixture quote missing')
    const reserved = await reserveAnalysisTask({
      tx,
      taskHooks: privateTaskHooks,
      taskId: id,
      userId: id,
      deviceId: 'fixture',
      batchId: id,
      version: 1,
      itemKey: 'inspect',
      attempt: 1,
      originConversationId: null,
      originTurnId: 'old-settled-turn',
      prepared,
      pricing: quote.pricing,
    })
    if (reserved.kind !== 'reserved') throw new Error('fixture reservation refused')
  })
  return prepared
}

it('recovers the durable cost after settlement committed but the billing read failed without another model call', async () => {
  const id = 'analysis-cost-recovery'
  await reserveIndependentFixture(id)
  let calls = 0
  setChatFetchForTesting(async () => {
    calls++
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({ findings: [{ imageId: 'image-1', text: 'known result' }] }),
          },
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    })
  })
  _setPrivateBffOverlayForTesting({
    ...EMPTY_PRIVATE_BFF_OVERLAY,
    present: true,
    taskHooks: {
      ...privateTaskHooks,
      taskCredits: async () => {
        throw new Error('fixture billing read unavailable')
      },
    },
  })
  try {
    await expect(runAnalysisTask(id)).rejects.toThrow('fixture billing read unavailable')
  } finally {
    _setPrivateBffOverlayForTesting({
      ...EMPTY_PRIVATE_BFF_OVERLAY,
      present: true,
      taskHooks: privateTaskHooks,
    })
  }
  expect(
    (await db.select().from(schema.analysis_tasks).where(eq(schema.analysis_tasks.task_id, id)))[0],
  ).toMatchObject({ status: 'completed', actual_credits: null })
  expect((await db.select().from(taskHolds).where(eq(taskHolds.task_id, id)))[0]).toMatchObject({
    status: 'committed',
    net_spend: 1,
  })
  await recoverAnalysisTasks()
  expect(
    (await db.select().from(schema.analysis_tasks).where(eq(schema.analysis_tasks.task_id, id)))[0],
  ).toMatchObject({ status: 'completed', actual_credits: 1 })
  expect(calls).toBe(1)
})

it.each([
  'confirm_success',
  'confirm_no_result',
] as const)('reconciles an unknown independent analysis through the operator API once with %s evidence', async (action) => {
  const id = `analysis-manual-${action}`
  await reserveIndependentFixture(id)
  let calls = 0
  setChatFetchForTesting(async () => {
    calls++
    throw new Error('accepted request connection lost')
  })
  await runAnalysisTask(id)
  await recoverAnalysisTasks()
  await runAnalysisTask(id)
  expect(calls).toBe(1)
  expect((await db.select().from(taskHolds).where(eq(taskHolds.task_id, id)))[0]?.status).toBe(
    'held',
  )
  expect(
    (
      await db
        .select()
        .from(schema.analysis_model_calls)
        .where(eq(schema.analysis_model_calls.task_id, id))
    )[0],
  ).toMatchObject({ http_dispatch_count: 1, usage: null })
  const { app } = await import('../../../app')
  const operate = (command: Record<string, unknown>) =>
    app.handle(
      new Request(`http://localhost/internal/admin/tasks/${id}/reconciliation`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer analysis-reconcile-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(command),
      }),
    )
  const lookup = await operate({
    commandId: 'lookup',
    operatorId: 'reviewer',
    action: 'lookup',
    evidence: 'Check persisted call evidence',
  })
  expect(lookup.status).toBe(200)
  expect(await lookup.json()).toMatchObject({
    status: 'reconciling',
    reason: 'manual_verification_required',
  })
  const result = {
    findings: [{ imageId: 'image-1', text: 'provider exported result' }],
    usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 },
  }
  const command = {
    commandId: 'verified',
    operatorId: 'reviewer',
    action,
    evidence: 'Provider support case verified',
    ...(action === 'confirm_success' ? { result } : {}),
  }
  const completed = await operate(command)
  expect(completed.status).toBe(200)
  const final = await completed.json()
  expect(final).toMatchObject({ status: action === 'confirm_success' ? 'completed' : 'failed' })
  expect(await (await operate(command)).json()).toEqual(final)
  expect((await operate({ ...command, evidence: 'different evidence' })).status).toBe(409)
  expect(calls).toBe(1)
  expect((await db.select().from(taskHolds).where(eq(taskHolds.task_id, id)))[0]).toMatchObject({
    status: action === 'confirm_success' ? 'committed' : 'released',
    net_spend: action === 'confirm_success' ? 1 : 0,
  })
  if (action === 'confirm_no_result')
    expect(
      (
        await db
          .select()
          .from(schema.analysis_model_calls)
          .where(eq(schema.analysis_model_calls.task_id, id))
      )[0]?.usage,
    ).toBeNull()
  expect(await db.select().from(schema.generation_records)).toHaveLength(0)
})

it('keeps a waived independent analysis and usage fact without creating a billing hold', async () => {
  const operator = config.operator
  const id = 'analysis-waived'
  let calls = 0
  config.operator = {
    ...operator,
    capabilities: { ...operator.capabilities, 'billing:chat-free': true },
  }
  try {
    await reserveIndependentFixture(id)
    setChatFetchForTesting(async () => {
      calls++
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [{ imageId: 'image-1', text: 'waived finding' }],
              }),
            },
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      })
    })
    await runAnalysisTask(id)
    expect(calls).toBe(1)
    expect(
      (
        await db.select().from(schema.analysis_tasks).where(eq(schema.analysis_tasks.task_id, id))
      )[0],
    ).toMatchObject({
      status: 'completed',
      reserved_credits: 0,
      actual_credits: 0,
      price_snapshot: { exemption: 'chat-free' },
      findings: [{ imageId: 'image-1', text: 'waived finding' }],
    })
    expect(
      (
        await db
          .select()
          .from(schema.analysis_model_calls)
          .where(eq(schema.analysis_model_calls.task_id, id))
      )[0],
    ).toMatchObject({
      http_dispatch_count: 1,
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 },
    })
    expect(await db.select().from(taskHolds).where(eq(taskHolds.task_id, id))).toHaveLength(0)
    expect(await db.select().from(creditLedger).where(eq(creditLedger.task_id, id))).toHaveLength(0)
  } finally {
    config.operator = operator
  }
})

it('records a final body rejection as zero usage and releases its own hold without sending', async () => {
  const id = 'analysis-local-body-rejection'
  await reserveIndependentFixture(id, '检查颜色。'.repeat(400))
  const operator = config.operator
  let calls = 0
  config.operator = { ...operator, quotas: { ...operator.quotas, 'agent:request-max-bytes': 1024 } }
  setChatFetchForTesting(async () => {
    calls++
    throw new Error('local rejection must not dispatch')
  })
  try {
    await runAnalysisTask(id)
  } finally {
    config.operator = operator
  }
  expect(calls).toBe(0)
  expect(
    (await db.select().from(schema.analysis_tasks).where(eq(schema.analysis_tasks.task_id, id)))[0],
  ).toMatchObject({ status: 'failed', actual_credits: 0, error_code: 'body_too_large' })
  expect(
    (
      await db
        .select()
        .from(schema.analysis_model_calls)
        .where(eq(schema.analysis_model_calls.task_id, id))
    )[0],
  ).toMatchObject({
    http_dispatch_count: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    local_rejection: 'body_too_large',
  })
  expect((await db.select().from(taskHolds).where(eq(taskHolds.task_id, id)))[0]).toMatchObject({
    status: 'released',
    net_spend: 0,
  })
})

it('retains deleted-conversation analysis evidence while unknown and releases source references only after reconciliation', async () => {
  const id = 'analysis-deleted-conversation'
  const prepared = await reserveIndependentFixture(id, 'private deleted instruction')
  const now = Date.now()
  const { images: _images, ...inputSnapshot } = prepared
  const [analysis] = await db
    .select()
    .from(schema.analysis_tasks)
    .where(eq(schema.analysis_tasks.task_id, id))
  if (!analysis) throw new Error('fixture analysis missing')
  await db
    .insert(schema.agent_conversations)
    .values({ id, user_id: id, title: 'private title', created_at: now, updated_at: now })
  await db.insert(schema.agent_batches).values({
    id,
    user_id: id,
    conversation_id: id,
    origin_turn_id: 'old-settled-turn',
    tool_call_id: 'analysis-plan',
    experience: 'chat',
    status: 'running',
    confirmed_version: 1,
    created_at: now,
    updated_at: now,
  })
  const emptyEstimate = {
    status: 'available' as const,
    estimatedCredits: 0,
    estimatedChargeCredits: 0,
    snapshots: [],
  }
  await db.insert(schema.agent_batch_plans).values({
    batch_id: id,
    version: 1,
    title: 'private title',
    rule: 'private rule',
    digest: 'fixture',
    item_count: 1,
    estimate_snapshot: { analysis: emptyEstimate, generation: emptyEstimate },
    created_at: now,
  })
  await db.insert(schema.agent_batch_items).values({
    batch_id: id,
    version: 1,
    key: 'inspect',
    ordinal: 0,
    kind: 'analysis',
    inputs: prepared.inputs,
    prompt: prepared.prompt,
    params: {
      model: id,
      estimatedInputTokens: prepared.estimatedInputTokens,
      evidence: prepared.evidence,
    },
    dependencies: [],
  })
  await db.insert(schema.agent_batch_attempts).values({
    batch_id: id,
    version: 1,
    item_key: 'inspect',
    attempt: 1,
    task_id: id,
    price_snapshot: analysis.price_snapshot,
    reserved_credits: analysis.reserved_credits,
    submitted_at: now,
  })
  await db
    .update(schema.analysis_tasks)
    .set({ origin_conversation_id: id })
    .where(eq(schema.analysis_tasks.task_id, id))
  await db.update(schema.tasks).set({ agent_conversation_id: id }).where(eq(schema.tasks.id, id))
  let calls = 0
  setChatFetchForTesting(async () => {
    calls++
    throw new Error('accepted result unknown')
  })
  await runAnalysisTask(id)
  const { detachConversationBatches, reconcileAgentBatchProgress } = await import(
    '../../../lib/agent/batch-progress'
  )
  const { cancelAnalysisTasks } = await import('../../../lib/analysis-tasks')
  const { lockConversation } = await import('../../../lib/agent/confirmations')
  await db.transaction(async (tx) => {
    await lockConversation(tx, id, id)
    await db
      .update(schema.agent_conversations)
      .set({ deleted_at: now })
      .where(eq(schema.agent_conversations.id, id))
    await detachConversationBatches(id, tx)
    await cancelAnalysisTasks(eq(schema.tasks.agent_conversation_id, id), tx)
  })
  await reconcileAgentBatchProgress(id)
  expect(
    (await db.select().from(schema.analysis_tasks).where(eq(schema.analysis_tasks.task_id, id)))[0],
  ).toMatchObject({ status: 'reconciling', input_snapshot: inputSnapshot })
  expect((await db.select().from(taskHolds).where(eq(taskHolds.task_id, id)))[0]?.status).toBe(
    'held',
  )
  expect(
    await db.select().from(schema.media_references).where(eq(schema.media_references.owner_id, id)),
  ).toHaveLength(1)
  const { app } = await import('../../../app')
  const operate = (command: Record<string, unknown>) =>
    app.handle(
      new Request(`http://localhost/internal/admin/tasks/${id}/reconciliation`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer analysis-reconcile-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(command),
      }),
    )
  expect(
    (
      await operate({
        commandId: 'lookup',
        operatorId: 'reviewer',
        action: 'lookup',
        evidence: 'Read persisted call',
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await operate({
        commandId: 'verified',
        operatorId: 'reviewer',
        action: 'confirm_success',
        evidence: 'Provider exported result',
        result: {
          findings: [{ imageId: 'image-1', text: 'verified finding' }],
          usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 },
        },
      })
    ).status,
  ).toBe(200)
  await reconcileAgentBatchProgress(id)
  expect(calls).toBe(1)
  expect((await db.select().from(taskHolds).where(eq(taskHolds.task_id, id)))[0]).toMatchObject({
    status: 'committed',
    net_spend: 1,
  })
  expect(
    await db.select().from(schema.media_references).where(eq(schema.media_references.owner_id, id)),
  ).toHaveLength(0)
  expect(
    (await db.select().from(schema.analysis_tasks).where(eq(schema.analysis_tasks.task_id, id)))[0],
  ).toMatchObject({
    status: 'completed',
    actual_credits: 1,
    input_snapshot: { prompt: '', inputs: [] },
    findings: [{ imageId: 'image-1', text: 'verified finding' }],
    coverage: { requiredImageIds: ['image-1'], reviewedImageIds: ['image-1'], missingImageIds: [] },
    evidence: prepared.evidence,
    price_snapshot: analysis.price_snapshot,
  })
  expect(
    (
      await db
        .select()
        .from(schema.analysis_model_calls)
        .where(eq(schema.analysis_model_calls.task_id, id))
    )[0],
  ).toMatchObject({
    http_dispatch_count: 1,
    usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 },
  })
})

it('bounds independent analysis output by both its approved reserve and the active model limit', async () => {
  const id = 'analysis-output-bound'
  await reserveIndependentFixture(id)
  const modelSettings = config.agent
  config.agent = { ...modelSettings, maxTokens: 128 }
  let sentOutputLimit: unknown
  setChatFetchForTesting(async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    sentOutputLimit = body.max_tokens
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({ findings: [{ imageId: 'image-1', text: 'bounded result' }] }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    })
  })
  try {
    await runAnalysisTask(id)
  } finally {
    config.agent = modelSettings
  }
  expect(sentOutputLimit).toBe(128)
  expect(
    (await db.select().from(schema.analysis_tasks).where(eq(schema.analysis_tasks.task_id, id)))[0],
  ).toMatchObject({ status: 'completed', price_snapshot: { outputReserveTokens: 1500 } })
})

it('sends the durable image-block identity and representation alongside an analysis request', async () => {
  const id = 'analysis-block-identity'
  await reserveIndependentFixture(id)
  let modelPrompt = ''
  setChatFetchForTesting(async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    modelPrompt = body.messages[0].content
      .filter((block: { type: string }) => block.type === 'text')
      .map((block: { text: string }) => block.text)
      .join('\n')
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [{ imageId: 'image-1', text: 'identified result' }],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    })
  })
  await runAnalysisTask(id)
  expect(modelPrompt).toContain('视觉输入 1：图片 image-1 缩略图')
  expect(modelPrompt).toContain('这些序号不是用户的 image 编号')
  expect(
    (await db.select().from(schema.analysis_tasks).where(eq(schema.analysis_tasks.task_id, id)))[0],
  ).toMatchObject({
    status: 'completed',
    evidence: [{ imageId: 'image-1', representation: 'preview' }],
  })
})

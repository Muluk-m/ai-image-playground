import { afterAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentBatchGenerationItem, AgentBatchPage } from '@image-playground/shared'

process.env.DATABASE_URL = await resetTestDatabase('batch_review')
process.env.PORT = '0'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../batch-execution-operator-config.json',
)
const { installRecordingTaskHooks } = await import('../helpers/privateOverlayStub')
installRecordingTaskHooks()
const { app } = await import('../../app')
const { db, schema, close } = await import('../../db/client')
const { quoteBatchPlan } = await import('../../lib/agent/batch-plans')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { loadPrivateBffOverlay, _setPrivateBffOverlayForTesting } = await import(
  '../../lib/private-overlay'
)
afterAll(async () => {
  _setPrivateBffOverlayForTesting()
  await close()
})

it('keeps archived unknown results reconciling in progress, execution and attempt history', async () => {
  const id = 'archived-unknown'
  const now = Date.now()
  await db.insert(schema.users).values({
    id,
    username: id,
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  const session = await db.transaction((tx) => createUserSession(id, tx))
  await db
    .insert(schema.agent_conversations)
    .values({ id, user_id: id, title: id, created_at: now, updated_at: now })
  await db.insert(schema.agent_batches).values({
    id,
    user_id: id,
    conversation_id: id,
    origin_turn_id: 'turn',
    tool_call_id: 'plan',
    experience: 'chat',
    status: 'paused',
    current_version: 1,
    confirmed_version: 1,
    created_at: now,
    updated_at: now,
  })
  const estimate = {
    status: 'available' as const,
    estimatedCredits: 7,
    estimatedChargeCredits: 7,
    snapshots: [],
  }
  await db.insert(schema.agent_batch_plans).values({
    batch_id: id,
    version: 1,
    title: id,
    rule: 'one item',
    digest: 'a'.repeat(64),
    item_count: 1,
    estimate_snapshot: { analysis: estimate, generation: estimate },
    created_at: now,
  })
  await db.insert(schema.agent_batch_items).values({
    batch_id: id,
    version: 1,
    key: 'one',
    ordinal: 0,
    kind: 'generation',
    inputs: [],
    prompt: 'one',
    params: { model: 'fixture', provider: 'openai-compat' },
    dependencies: [],
  })
  await db.insert(schema.agent_batch_attempts).values({
    batch_id: id,
    version: 1,
    item_key: 'one',
    attempt: 1,
    task_id: 'purged-unknown',
    reserved_credits: 7,
    submitted_at: now,
    terminal_snapshot: {
      status: 'failed',
      completedAt: now,
      upstreamStatus: null,
      actualCredits: null,
      artifacts: [],
      errorCode: 'result_unknown',
      message: 'awaiting reconciliation',
    },
  })
  const response = await app.handle(
    new Request(`http://localhost/api/agent/batches/${id}`, {
      headers: { cookie: `${USER_SESSION_COOKIE}=${session}` },
    }),
  )
  expect(response.status).toBe(200)
  const page = (await response.json()) as AgentBatchPage
  expect(page.items[0]?.progress).toBe('reconciling')
  expect(page.items[0]?.execution?.status).toBe('reconciling')
  expect(page.items[0]?.attempts?.[0]?.status).toBe('reconciling')
  const { reconcileAgentBatchProgress } = await import('../../lib/agent/batch-progress')
  const { eq } = await import('drizzle-orm')
  await reconcileAgentBatchProgress(id)
  const [unresolved] = await db
    .select()
    .from(schema.agent_batches)
    .where(eq(schema.agent_batches.id, id))
  expect(unresolved?.status).toBe('paused')
  expect(
    await db.select().from(schema.agent_inbox).where(eq(schema.agent_inbox.conversation_id, id)),
  ).toHaveLength(0)
  await db
    .update(schema.agent_batches)
    .set({ conversation_id: null })
    .where(eq(schema.agent_batches.id, id))
  await reconcileAgentBatchProgress(id)
  const [retained] = await db
    .select()
    .from(schema.agent_batch_items)
    .where(eq(schema.agent_batch_items.batch_id, id))
  expect(retained?.prompt).toBe('one')
})

it('quotes each generation model once per plan while preserving every item price and total', async () => {
  const overlay = await loadPrivateBffOverlay()
  let calls = 0
  _setPrivateBffOverlayForTesting({
    ...overlay,
    taskHooks: {
      ...overlay.taskHooks,
      async quoteTask({ model, quantity, unitMultiplier }) {
        calls += 1
        return {
          estimatedCredits: 7,
          pricing: {
            model,
            unit: 'image',
            quantity,
            unitMultiplier,
            baseUnitCredits: 7,
            pricingVersion: 'price-7',
            quotedAt: 1000,
            validUntil: null,
            outputPriceRatio: 0,
            cachedInputPriceRatio: 0,
            inputEstimateTokens: 0,
            outputReserveTokens: 0,
            exemption: 'none',
          },
        }
      },
    },
  })
  const items: AgentBatchGenerationItem[] = Array.from({ length: 100 }, (_, index) => ({
    kind: 'generation',
    key: `item-${index}`,
    ordinal: index,
    inputs: [],
    prompt: 'one',
    params: { model: 'fixture', provider: 'openai-compat' },
    dependencies: [],
  }))
  const estimate = await db.transaction((tx) => quoteBatchPlan(tx, 'archived-unknown', items))
  expect(estimate.generation).toMatchObject({
    status: 'available',
    estimatedCredits: 700,
    estimatedChargeCredits: 700,
  })
  expect(
    estimate.generation.status === 'available' &&
      estimate.generation.snapshots.map((one) => one.itemKey),
  ).toEqual(items.map((one) => one.key))
  expect(calls).toBe(1)
})

async function seedDependencyBatch(id: string, status: 'failed' | 'cancelled') {
  const now = Date.now()
  await db.insert(schema.users).values({
    id,
    username: id,
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  const session = await db.transaction((tx) => createUserSession(id, tx))
  await db
    .insert(schema.agent_conversations)
    .values({ id, user_id: id, title: id, created_at: now, updated_at: now })
  await db.insert(schema.agent_batches).values({
    id,
    user_id: id,
    conversation_id: id,
    origin_turn_id: 'turn',
    tool_call_id: 'plan',
    experience: 'chat',
    status: 'running',
    current_version: 1,
    confirmed_version: 1,
    created_at: now,
    updated_at: now,
  })
  const estimate = {
    status: 'available' as const,
    estimatedCredits: 21,
    estimatedChargeCredits: 21,
    snapshots: [],
  }
  await db.insert(schema.agent_batch_plans).values({
    batch_id: id,
    version: 1,
    title: id,
    rule: 'dependency chain',
    digest: 'b'.repeat(64),
    item_count: 3,
    estimate_snapshot: { analysis: estimate, generation: estimate },
    created_at: now,
  })
  await db.insert(schema.agent_batch_items).values(
    ['one', 'two', 'three'].map((key, ordinal) => ({
      batch_id: id,
      version: 1,
      key,
      ordinal,
      kind: 'generation' as const,
      inputs: [],
      prompt: key,
      params: { model: 'gpt-image-2.5-flare', provider: 'openai-compat' as const },
      dependencies: ordinal ? [ordinal === 1 ? 'one' : 'two'] : [],
    })),
  )
  await db.insert(schema.agent_batch_attempts).values({
    batch_id: id,
    version: 1,
    item_key: 'one',
    attempt: 1,
    task_id: `${id}-first`,
    reserved_credits: 7,
    submitted_at: now,
    terminal_snapshot: {
      status,
      completedAt: now,
      upstreamStatus: null,
      actualCredits: 0,
      artifacts: [],
      errorCode: status === 'cancelled' ? 'cancelled' : 'upstream_error',
      message: status,
    },
  })
  const read = () =>
    app.handle(
      new Request(`http://localhost/api/agent/batches/${id}`, {
        headers: { cookie: `${USER_SESSION_COOKIE}=${session}` },
      }),
    )
  return { read, session }
}

it('quotes retry and every never-submitted downstream item before authorizing resumed execution', async () => {
  const { TEST_IMAGE_CHANNEL } = await import('../helpers/agentStubs')
  const { _setChannelsForTesting } = await import('../../lib/channels')
  _setChannelsForTesting([TEST_IMAGE_CHANNEL])
  const { session } = await seedDependencyBatch('retry-downstream', 'failed')
  const response = await app.handle(
    new Request('http://localhost/api/agent/batches/retry-downstream/retry-quote', {
      method: 'POST',
      headers: { cookie: `${USER_SESSION_COOKIE}=${session}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: 1,
        commandId: crypto.randomUUID(),
        itemKeys: ['one'],
      }),
    }),
  )
  expect(response.status).toBe(200)
  const page = (await response.json()) as AgentBatchPage
  expect(page.batch.estimate.generation).toMatchObject({
    status: 'available',
    estimatedCredits: 21,
    estimatedChargeCredits: 21,
  })
  expect(page.batch.retryItemKeys).toEqual(['one'])
  expect(page.batch.submittedCount).toBe(1)
})

it('closes cancelled dependency chains without manufacturing submissions or reservations', async () => {
  const { read } = await seedDependencyBatch('cancel-chain', 'cancelled')
  const { reconcileAgentBatchProgress } = await import('../../lib/agent/batch-progress')
  await reconcileAgentBatchProgress('cancel-chain')
  const response = await read()
  expect(response.status).toBe(200)
  const page = (await response.json()) as AgentBatchPage
  expect(page.batch.status).toBe('closed')
  expect(page.items.map((item) => item.progress)).toEqual(['cancelled', 'cancelled', 'cancelled'])
  expect(page.batch.submittedCount).toBe(1)
  expect(page.items[1]?.execution).toBeUndefined()
  expect(page.items[2]?.execution).toBeUndefined()
  const { batchWakeSummary } = await import('../../lib/agent/batch-wake')
  const summary = await batchWakeSummary(
    'cancel-chain',
    { kind: 'user', userId: 'cancel-chain' },
    { batchId: 'cancel-chain', version: 1, eventVersion: 1, itemKeys: ['one', 'two', 'three'] },
  )
  expect(summary).not.toBeNull()
  const results = JSON.parse(summary!.split('\n')[2]!)
  expect(results).toEqual([
    { itemKey: 'one', attempt: 1, status: 'cancelled', actualCredits: 0 },
    { itemKey: 'two', attempt: null, status: 'cancelled', actualCredits: 0 },
    { itemKey: 'three', attempt: null, status: 'cancelled', actualCredits: 0 },
  ])
})

it('settles detached unconfirmed batches and erases abandoned inputs even when execution is disabled', async () => {
  const { eq } = await import('drizzle-orm')
  const { config } = await import('../../config')
  const { advanceAgentBatches } = await import('../../lib/agent/batch-execution')
  await seedDependencyBatch('detached-unconfirmed', 'failed')
  await db
    .update(schema.agent_batches)
    .set({ conversation_id: null, confirmed_version: null, status: 'paused' })
    .where(eq(schema.agent_batches.id, 'detached-unconfirmed'))
  const operator = config.operator
  config.operator = {
    ...operator,
    capabilities: { ...operator.capabilities, 'agent:batch-execution': false },
  }
  try {
    await advanceAgentBatches(null, () => true)
  } finally {
    config.operator = operator
  }
  const [batch] = await db
    .select()
    .from(schema.agent_batches)
    .where(eq(schema.agent_batches.id, 'detached-unconfirmed'))
  expect(batch?.status).toBe('closed')
  const items = await db
    .select()
    .from(schema.agent_batch_items)
    .where(eq(schema.agent_batch_items.batch_id, 'detached-unconfirmed'))
  expect(items.map((item) => item.prompt)).toEqual(['', '', ''])
})

import { afterAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentBatchPage } from '@image-playground/shared'
import { inArray, sql } from 'drizzle-orm'

process.env.DATABASE_URL = await resetTestDatabase('batch_page_pool')
process.env.PORT = '0'
process.env.DATABASE_POOL_MAX = '1'
// A pool checkout deadlock must fail deterministically and release the reserved connection.
process.env.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS = '1000'
process.env.DATABASE_STATEMENT_TIMEOUT_MS = '1000'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../batch-execution-operator-config.json',
)
const { installRecordingTaskHooks } = await import('../helpers/privateOverlayStub')
installRecordingTaskHooks()
const { config } = await import('../../config')
const { app } = await import('../../app')
const { readAgentBatchPlan } = await import('../../lib/agent/batch-plans')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { loadPrivateBffOverlay, _setPrivateBffOverlayForTesting } = await import(
  '../../lib/private-overlay'
)
afterAll(async () => {
  _setPrivateBffOverlayForTesting()
  await close()
})

async function seed(id: string, legacy = false) {
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
    .values({ id, user_id: id, title: 'one pool connection', created_at: now, updated_at: now })
  await db.insert(schema.agent_batches).values({
    id,
    user_id: id,
    conversation_id: id,
    origin_turn_id: 'origin',
    tool_call_id: 'plan',
    experience: 'chat',
    status: 'paused',
    current_version: 2,
    created_at: now,
    updated_at: now,
  })
  const quote = {
    status: 'available' as const,
    estimatedCredits: 0,
    estimatedChargeCredits: 0,
    snapshots: [],
  }
  for (const version of [1, 2]) {
    await db.insert(schema.agent_batch_plans).values({
      batch_id: id,
      version,
      title: 'single connection',
      rule: 'read current and source summaries',
      digest: String(version).repeat(64),
      item_count: 1,
      estimate_snapshot: { analysis: quote, generation: quote },
      confirmation: {
        phase: 'analysis',
        requiresResume: false,
        itemKeys: [version === 1 ? 'original' : 'followup'],
        ...(version === 2 ? { sourceVersion: 1, sourceVersions: [1] } : {}),
      },
      created_at: now,
    })
    await db.insert(schema.agent_batch_items).values({
      batch_id: id,
      version,
      key: version === 1 ? 'original' : 'followup',
      ordinal: 0,
      kind: 'analysis',
      inputs: [],
      prompt: 'inspect',
      params: { model: 'fixture', estimatedInputTokens: 0, evidence: [] },
      dependencies: [],
    })
  }
  if (legacy) {
    await db.insert(schema.tasks).values({
      id: `${id}-task`,
      user_id: id,
      provider: 'openai-compat',
      model: 'fixture',
      status: 'failed',
      request_payload: { device_id: 'fixture', prompt: 'legacy', n: 1 },
      submitted_at: now,
      completed_at: now,
    })
    await db.insert(schema.agent_batch_attempts).values({
      batch_id: id,
      version: 2,
      item_key: 'followup',
      attempt: 1,
      task_id: `${id}-task`,
      reserved_credits: 7,
      submitted_at: now,
    })
  }
  return () =>
    app.handle(
      new Request(`http://localhost/api/agent/batches/${id}?limit=1`, {
        headers: { cookie: `${USER_SESSION_COOKIE}=${session}` },
      }),
    )
}

it('serves simultaneous current/source summary pages without requiring a second pool connection', async () => {
  expect(config.databasePool.max).toBe(1)
  const read = await seed('summary-pool-owner')
  // All materialized inputs, including nested source summaries, belong to the page snapshot.
  await db.execute(sql`CREATE FUNCTION page_pool_inputs(value jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
    BEGIN
      IF current_setting('transaction_isolation') <> 'repeatable read' THEN
        RAISE EXCEPTION 'summary_outside_page_snapshot: pid=%, isolation=%', pg_backend_pid(), current_setting('transaction_isolation');
      END IF;
      RETURN value;
    END $$`)
  await db.execute(sql`ALTER TABLE agent_batch_items RENAME TO page_pool_items`)
  await db.execute(sql`DO $$ DECLARE fields text; BEGIN
    SELECT string_agg(CASE WHEN column_name = 'inputs' THEN 'page_pool_inputs(inputs) AS inputs'
      ELSE quote_ident(column_name) END, ', ' ORDER BY ordinal_position)
      INTO fields FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'page_pool_items';
    EXECUTE 'CREATE VIEW agent_batch_items AS SELECT ' || fields || ' FROM page_pool_items';
  END $$`)
  try {
    await expect(
      Promise.resolve(
        db
          .select({ inputs: schema.agent_batch_items.inputs })
          .from(schema.agent_batch_items)
          .limit(1),
      ),
    ).rejects.toMatchObject({
      cause: { message: expect.stringContaining('summary_outside_page_snapshot') },
    })
    const guarded = await db.transaction(
      (tx) =>
        tx
          .select({ inputs: schema.agent_batch_items.inputs })
          .from(schema.agent_batch_items)
          .limit(1),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
    expect(guarded).toEqual([{ inputs: [] }])
    const responses = await Promise.all([read(), read()])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    for (const response of responses) {
      const page = (await response.json()) as AgentBatchPage
      expect(page.items.map((item) => item.key)).toEqual(['followup'])
      expect(page.analysisSummary?.unresolvedItemKeys).toEqual(['followup'])
      expect(page.sourceAnalysisSummary?.unresolvedItemKeys).toEqual(['original'])
    }
    // Agent tools call the same reader directly, outside Elysia's request context.
    const direct = await readAgentBatchPlan('summary-pool-owner', 'summary-pool-owner', {
      limit: 1,
    })
    expect(direct?.items.map((item) => item.key)).toEqual(['followup'])
    expect(direct?.sourceAnalysisSummary?.unresolvedItemKeys).toEqual(['original'])
  } finally {
    await db.execute(sql`DROP VIEW agent_batch_items`)
    await db.execute(sql`ALTER TABLE page_pool_items RENAME TO agent_batch_items`)
    await db.execute(sql`DROP FUNCTION page_pool_inputs(jsonb)`)
  }
  expect((await db.execute(sql`select 1 as usable`))[0]?.usable).toBe(1)
}, 10_000)

it('counts a settled attempt once when archival happens during its legacy billing lookup', async () => {
  const overlay = await loadPrivateBffOverlay()
  let reads = 0
  _setPrivateBffOverlayForTesting({
    ...overlay,
    taskHooks: {
      ...overlay.taskHooks,
      async taskCredits({ taskIds }) {
        reads++
        await db
          .update(schema.agent_batch_attempts)
          .set({
            terminal_snapshot: {
              status: 'failed',
              actualCredits: 7,
              completedAt: Date.now(),
              upstreamStatus: null,
              artifacts: [],
              errorCode: null,
              message: null,
            },
          })
          .where(inArray(schema.agent_batch_attempts.task_id, [...taskIds]))
        const tasks = await db
          .select({ id: schema.tasks.id })
          .from(schema.tasks)
          .where(inArray(schema.tasks.id, [...taskIds]))
        return Object.fromEntries(tasks.map((task) => [task.id, 7]))
      },
    },
  })
  const read = await seed('archival-pool-owner', true)
  for (let request = 0; request < 2; request++) {
    const response = await read()
    expect(response.status).toBe(200)
    const page = (await response.json()) as AgentBatchPage
    expect(page.batch.actualCredits).toBe(7)
    expect(page.items[0]?.execution?.actualCredits).toBe(7)
    expect(page.items[0]?.attempts?.map((attempt) => attempt.actualCredits)).toEqual([7])
  }
  expect(reads).toBe(1)
}, 10_000)

it('releases the page transaction before the legacy billing hook reads the same pool', async () => {
  expect(config.databasePool.max).toBe(1)
  const overlay = await loadPrivateBffOverlay()
  let reads = 0
  _setPrivateBffOverlayForTesting({
    ...overlay,
    taskHooks: {
      ...overlay.taskHooks,
      async taskCredits({ taskIds }) {
        reads++
        // The private billing hook uses this same public host pool, not the caller's transaction.
        const tasks = await db
          .select({ id: schema.tasks.id })
          .from(schema.tasks)
          .where(inArray(schema.tasks.id, [...taskIds]))
        return Object.fromEntries(tasks.map((task) => [task.id, 7]))
      },
    },
  })
  const read = await seed('legacy-pool-owner', true)
  const responses = await Promise.all([read(), read()])
  expect(responses.map((response) => response.status)).toEqual([200, 200])
  expect(reads).toBe(2)
  for (const response of responses) {
    const page = (await response.json()) as AgentBatchPage
    expect(page.batch.actualCredits).toBe(7)
    expect(page.items[0]?.execution?.actualCredits).toBe(7)
  }
  expect((await db.execute(sql`select 1 as usable`))[0]?.usable).toBe(1)
}, 10_000)

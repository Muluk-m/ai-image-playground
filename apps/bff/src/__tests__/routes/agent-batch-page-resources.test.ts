import { afterAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentBatchPage } from '@image-playground/shared'
import { sql } from 'drizzle-orm'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'

process.env.DATABASE_URL = await resetTestDatabase('batch_page_resources')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../batch-execution-operator-config.json',
)
const billing = installRecordingTaskHooks()
const { app } = await import('../../app')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
afterAll(close)

it('reads only page result payloads while preserving global costs, cross-page dependencies and all visible attempts', async () => {
  const id = 'page-resource-owner'
  const now = Date.now()
  billing.creditsPerTask = 2
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
    .values({ id, user_id: id, title: 'bounded page', created_at: now, updated_at: now })
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
  const quote = {
    status: 'available' as const,
    estimatedCredits: 0,
    estimatedChargeCredits: 0,
    snapshots: [],
  }
  await db.insert(schema.agent_batch_plans).values({
    batch_id: id,
    version: 1,
    title: 'bounded page',
    rule: 'keep all history',
    digest: 'a'.repeat(64),
    item_count: 21,
    estimate_snapshot: { analysis: quote, generation: quote },
    attempt_targets: { 'item-1': 3 },
    created_at: now,
  })
  await db.insert(schema.agent_batch_items).values(
    Array.from({ length: 21 }, (_, ordinal) => ({
      batch_id: id,
      version: 1,
      key: `item-${ordinal}`,
      ordinal,
      kind: 'generation' as const,
      inputs: [],
      prompt: `item ${ordinal}`,
      params: { model: 'fixture', provider: 'openai-compat' as const },
      dependencies: ordinal === 0 ? ['item-20'] : [],
    })),
  )
  for (let ordinal = 1; ordinal <= 20; ordinal++) {
    for (let attempt = 1; attempt <= (ordinal === 1 ? 3 : 1); attempt++) {
      const taskId = `item-${ordinal}-attempt-${attempt}`
      await db.insert(schema.tasks).values({
        id: taskId,
        user_id: id,
        provider: 'openai-compat',
        model: 'fixture',
        status: 'failed',
        request_payload: { device_id: 'fixture', prompt: 'fixture', n: 1 },
        result_payload: { historicalBody: 'x'.repeat(4096) },
        error_type: 'timeout',
        submitted_at: now,
        completed_at: now,
      })
      await db.insert(schema.agent_batch_attempts).values({
        batch_id: id,
        version: 1,
        item_key: `item-${ordinal}`,
        attempt,
        task_id: taskId,
        reserved_credits: 2,
        submitted_at: now,
      })
    }
  }
  // A database-side materialization guard represents expensive result bodies. The real HTTP
  // reader may inspect any status/cost row, but loading a body outside the requested page fails.
  // This observes the storage boundary without mocking the batch service or timing heap growth.
  await db.execute(sql`CREATE TABLE page_allowed_payloads (task_id text PRIMARY KEY)`)
  await db.execute(
    sql`INSERT INTO page_allowed_payloads SELECT id FROM tasks WHERE id <> 'item-20-attempt-1'`,
  )
  await db.execute(sql`CREATE FUNCTION page_payload(task_id text, body jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM page_allowed_payloads a WHERE a.task_id = page_payload.task_id) THEN
        RAISE EXCEPTION 'off_page_result_payload_materialized: %', task_id;
      END IF;
      RETURN body;
    END $$`)
  await db.execute(sql`ALTER TABLE tasks RENAME TO page_fixture_tasks`)
  await db.execute(sql`DO $$ DECLARE fields text; BEGIN
    SELECT string_agg(CASE WHEN column_name = 'result_payload'
      THEN 'page_payload(id, result_payload) AS result_payload'
      ELSE quote_ident(column_name) END, ', ' ORDER BY ordinal_position)
      INTO fields FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'page_fixture_tasks';
    EXECUTE 'CREATE VIEW tasks AS SELECT ' || fields || ' FROM page_fixture_tasks';
  END $$`)
  try {
    const read = (cursor?: string) =>
      app.handle(
        new Request(
          `http://localhost/api/agent/batches/${id}?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          { headers: { cookie: `${USER_SESSION_COOKIE}=${session}` } },
        ),
      )
    const firstResponse = await read()
    expect(firstResponse.status).toBe(200)
    const first = (await firstResponse.json()) as AgentBatchPage
    expect(first.items).toHaveLength(20)
    expect(first.batch.submittedCount).toBe(22)
    expect(first.batch.actualCredits).toBe(44)
    expect(first.items[0]).toMatchObject({
      key: 'item-0',
      progress: 'blocked',
      blockedBy: ['item-20'],
    })
    expect(first.items[1]?.attempts?.map((one) => one.attempt)).toEqual([1, 2, 3])
    expect(first.items[1]?.execution).toMatchObject({
      taskId: 'item-1-attempt-3',
      actualCredits: 2,
    })
    expect(first.nextCursor).not.toBeNull()
    await db.execute(sql`DELETE FROM page_allowed_payloads`)
    await db.execute(sql`INSERT INTO page_allowed_payloads VALUES ('item-20-attempt-1')`)
    const secondResponse = await read(first.nextCursor!)
    expect(secondResponse.status).toBe(200)
    const second = (await secondResponse.json()) as AgentBatchPage
    expect(second.items.map((item) => item.key)).toEqual(['item-20'])
    expect(second.items[0]?.attempts).toHaveLength(1)
    expect(second.items[0]?.execution).toMatchObject({
      taskId: 'item-20-attempt-1',
      actualCredits: 2,
    })
    expect(second.batch.submittedCount).toBe(22)
    expect(second.batch.actualCredits).toBe(44)
    expect(second.nextCursor).toBeNull()
  } finally {
    await db.execute(sql`DROP VIEW tasks`)
    await db.execute(sql`ALTER TABLE page_fixture_tasks RENAME TO tasks`)
    await db.execute(sql`DROP FUNCTION page_payload(text, jsonb)`)
    await db.execute(sql`DROP TABLE page_allowed_payloads`)
  }
})

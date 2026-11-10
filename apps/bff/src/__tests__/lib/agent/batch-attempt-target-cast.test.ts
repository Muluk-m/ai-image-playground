import { afterAll, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { sql } from 'drizzle-orm'

process.env.DATABASE_URL = await resetTestDatabase('bff_batch_attempt_cast')
process.env.PORT = '0'

const { db, schema, close } = await import('../../../db/client')
const { readFrozenDependencyTargets } = await import('../../../lib/agent/batch-dependencies')

afterAll(close)

it('resolves dirty attempt_targets without aborting the batch query', async () => {
  const id = 'dirty-attempt-targets'
  const now = Date.now()
  await db.insert(schema.users).values({
    id,
    username: id,
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  await db.insert(schema.agent_batches).values({
    id,
    user_id: id,
    origin_turn_id: 'turn',
    tool_call_id: 'plan',
    experience: 'chat',
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
      title: 'dirty targets',
      rule: 'keep going',
      digest: String(version).repeat(64),
      item_count: version === 1 ? 3 : 1,
      estimate_snapshot: { analysis: quote, generation: quote },
      attempt_targets: {},
      created_at: now,
    })
  }
  await db.execute(sql`
    UPDATE agent_batch_plans
    SET attempt_targets = '{"dep":"1.5","ok":2,"blank":""}'::jsonb
    WHERE batch_id = ${id} AND version = 1
  `)
  await db.insert(schema.agent_batch_items).values([
    ...['dep', 'ok', 'blank'].map((key, ordinal) => ({
      batch_id: id,
      version: 1,
      key,
      ordinal,
      kind: 'analysis' as const,
      inputs: [],
      prompt: key,
      params: { model: 'fixture', estimatedInputTokens: 0, evidence: [] },
      dependencies: [],
    })),
    {
      batch_id: id,
      version: 2,
      key: 'child',
      ordinal: 0,
      kind: 'analysis' as const,
      inputs: [],
      prompt: 'child',
      params: { model: 'fixture', estimatedInputTokens: 0, evidence: [] },
      dependencies: ['dep', 'ok', 'blank'],
    },
  ])
  await db.insert(schema.agent_batch_attempts).values(
    [
      ['dep', 1],
      ['dep', 2],
      ['ok', 1],
      ['ok', 2],
      ['blank', 1],
    ].map(([key, attempt]) => ({
      batch_id: id,
      version: 1,
      item_key: String(key),
      attempt: Number(attempt),
      task_id: `${id}-${key}-${attempt}`,
      reserved_credits: 0,
      submitted_at: now,
    })),
  )

  const rows = await readFrozenDependencyTargets(
    db,
    id,
    2,
    [1],
    [{ key: 'child', dependencies: ['dep', 'ok', 'blank'] }],
  )
  expect(rows.map((row) => [row.key, row.taskId]).sort()).toEqual([
    ['blank', `${id}-blank-1`],
    ['dep', `${id}-dep-1`],
    ['ok', `${id}-ok-2`],
  ])
})

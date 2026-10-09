import { afterAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { and, eq } from 'drizzle-orm'

process.env.DATABASE_URL = await resetTestDatabase('batch_wake_receipt')
process.env.PORT = '0'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../batch-execution-operator-config.json',
)
const { installRecordingTaskHooks } = await import('../helpers/privateOverlayStub')
installRecordingTaskHooks()
const { app } = await import('../../app')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
afterAll(close)

it('reports each owned batch version wake independently without starting a turn', async () => {
  const now = Date.now()
  await db.insert(schema.users).values(
    ['owner', 'other'].map((id) => ({
      id,
      username: id,
      password_hash: 'fixture',
      status: 'active' as const,
      created_at: now,
      updated_at: now,
    })),
  )
  const session = await db.transaction((tx) => createUserSession('owner', tx))
  const otherSession = await db.transaction((tx) => createUserSession('other', tx))
  await db.insert(schema.agent_conversations).values({
    id: 'conversation',
    user_id: 'owner',
    title: 'Two batches',
    created_at: now,
    updated_at: now,
  })
  const estimate = {
    status: 'available' as const,
    estimatedCredits: 0,
    estimatedChargeCredits: 0,
    snapshots: [],
  }
  for (const id of ['first', 'second']) {
    await db.insert(schema.agent_batches).values({
      id,
      user_id: 'owner',
      conversation_id: 'conversation',
      origin_turn_id: 'origin',
      tool_call_id: id,
      experience: 'chat',
      status: 'closed',
      current_version: 2,
      confirmed_version: 2,
      created_at: now,
      updated_at: now,
    })
    await db.insert(schema.agent_batch_plans).values(
      [1, 2].map((version) => ({
        batch_id: id,
        version,
        title: id,
        rule: 'one item',
        digest: 'a'.repeat(64),
        item_count: 1,
        estimate_snapshot: { analysis: estimate, generation: estimate },
        created_at: now,
      })),
    )
  }
  const read = (id: string, version = 2, token = session) =>
    app.handle(
      new Request(`http://localhost/api/agent/batches/${id}/wake?version=${version}`, {
        headers: { cookie: `${USER_SESSION_COOKIE}=${token}` },
      }),
    )
  expect((await read('first')).status).toBe(200)
  expect(await (await read('first')).json()).toEqual({ status: 'pending' })
  await db.insert(schema.agent_inbox).values([
    {
      conversation_id: 'conversation',
      id: 'batch-result:first:2',
      seq: 1,
      kind: 'task_result',
      status: 'consumed',
      consumed_turn_id: 'first-summary',
      payload: {
        turnId: 'origin',
        taskIds: [],
        deviceId: 'device',
        batch: { batchId: 'first', version: 2, eventVersion: 1, itemKeys: ['one'] },
      },
      created_at: now,
    },
    {
      conversation_id: 'conversation',
      id: 'batch-result:second:2',
      seq: 2,
      kind: 'task_result',
      status: 'pending',
      payload: {
        turnId: 'origin',
        taskIds: [],
        deviceId: 'device',
        batch: { batchId: 'second', version: 2, eventVersion: 1, itemKeys: ['one'] },
      },
      created_at: now,
    },
  ])
  expect(await (await read('first')).json()).toEqual({
    status: 'consumed',
    turnId: 'first-summary',
  })
  expect(await (await read('second')).json()).toEqual({ status: 'pending' })
  expect(await (await read('first', 1)).json()).toEqual({ status: 'pending' })
  await db
    .update(schema.agent_inbox)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(schema.agent_inbox.conversation_id, 'conversation'),
        eq(schema.agent_inbox.id, 'batch-result:second:2'),
      ),
    )
  expect(await (await read('second')).json()).toEqual({ status: 'skipped' })
  expect((await read('first', 3)).status).toBe(404)
  expect((await read('first', 2, otherSession)).status).toBe(404)
  expect(
    (await app.handle(new Request('http://localhost/api/agent/batches/first/wake?version=2')))
      .status,
  ).toBe(401)
  expect(await db.select().from(schema.agent_turns)).toHaveLength(0)
  await db
    .update(schema.agent_conversations)
    .set({ deleted_at: now })
    .where(eq(schema.agent_conversations.id, 'conversation'))
  expect((await read('first')).status).toBe(404)
})

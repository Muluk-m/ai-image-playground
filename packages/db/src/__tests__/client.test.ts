import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createDb } from '../client'
import { resetTestDatabase } from '../testing'

let databaseUrl: string
const closeCallbacks: Array<() => Promise<void>> = []

beforeAll(async () => {
  databaseUrl = await resetTestDatabase('db_client')
}, 30_000)

afterAll(async () => {
  await Promise.all(closeCallbacks.map((close) => close()))
}, 30_000)

function handle() {
  const created = createDb(databaseUrl)
  closeCallbacks.push(created.close)
  return created
}

describe('createDb', () => {
  it('round-trips epoch milliseconds and JSONB while deriving device_id', async () => {
    const { db, schema } = handle()
    const submittedAt = 1_786_264_321_123
    await db.insert(schema.tasks).values({
      id: 'test-rw',
      provider: 'openai-compat',
      model: 'm',
      status: 'queued',
      request_payload: { prompt: 'x', device_id: 'd-aaaaaaaa' },
      submitted_at: submittedAt,
    })

    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, 'test-rw'))
    expect(task?.submitted_at).toBe(submittedAt)
    expect(task?.request_payload).toMatchObject({ prompt: 'x', device_id: 'd-aaaaaaaa' })
    expect(task?.device_id).toBe('d-aaaaaaaa')
  })

  it('cascades user deletion to sessions', async () => {
    const { db, schema } = handle()
    await db.insert(schema.users).values({
      id: 'user-fk',
      username: 'foreign-key-user',
      password_hash: 'hash',
      status: 'active',
      created_at: 1,
      updated_at: 1,
    })
    await db.insert(schema.user_sessions).values({
      token_hash: 'session-fk',
      user_id: 'user-fk',
      created_at: 1,
      expires_at: 2,
    })

    await db.delete(schema.users).where(eq(schema.users.id, 'user-fk'))
    expect(await db.select().from(schema.user_sessions)).toHaveLength(0)
  })
})

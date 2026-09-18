import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { SQL } from 'bun'
import { eq } from 'drizzle-orm'
import { createDb, databasePoolMaxFromEnv } from '../client'
import { resetTestDatabase } from '../testing'

let databaseUrl: string
const closeCallbacks: Array<() => Promise<void>> = []

beforeAll(async () => {
  databaseUrl = await resetTestDatabase('db_client')
}, 30_000)

afterAll(async () => {
  await Promise.all(closeCallbacks.map((close) => close()))
}, 30_000)

function handle(pool?: Parameters<typeof createDb>[1]) {
  const created = createDb(databaseUrl, pool)
  closeCallbacks.push(created.close)
  return created
}

describe('createDb pool', () => {
  // Bun reports both timeouts in milliseconds even though it takes them in seconds.
  it('releases idle connections after 30 s and keeps connections without a lifetime cap', () => {
    const { client } = handle()
    expect(client.options.max).toBe(10)
    expect(client.options.idleTimeout).toBe(30_000)
    expect(client.options.maxLifetime ?? 0).toBe(0)
  })

  it('passes explicit pool limits to the driver', () => {
    const { client } = handle({ max: 3, idleTimeout: 5, maxLifetime: 600 })
    expect(client.options.max).toBe(3)
    expect(client.options.idleTimeout).toBe(5_000)
    expect(client.options.maxLifetime).toBe(600_000)
  })

  it('queues a burst beyond max, then closes the idle connections it opened', async () => {
    const { client } = handle({ max: 3, idleTimeout: 1 })
    const burst = await Promise.all(
      Array.from(
        { length: 7 },
        () =>
          client`SELECT pg_backend_pid() AS pid, pg_sleep(0.1)` as Promise<Array<{ pid: number }>>,
      ),
    )
    const pids = [...new Set(burst.map(([row]) => row!.pid))]
    expect(pids).toHaveLength(3)

    const observer = new SQL(databaseUrl, { max: 1 })
    closeCallbacks.push(() => observer.close())
    const open = async () => {
      const [row] = await observer`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = ANY(${observer.array(pids, 'INT4')})`
      return (row as { n: number }).n
    }
    expect(await open()).toBe(3)
    const deadline = Date.now() + 5_000
    while ((await open()) > 0 && Date.now() < deadline) await Bun.sleep(100)
    expect(await open()).toBe(0)

    // A pool that dropped its idle connections reconnects on the next query.
    const [reconnected] = await client`SELECT 1 AS one`
    expect(reconnected).toEqual({ one: 1 })
  })
})

describe('databasePoolMaxFromEnv', () => {
  it('leaves the driver default in place when unset or blank', () => {
    expect(databasePoolMaxFromEnv({})).toBeUndefined()
    expect(databasePoolMaxFromEnv({ DATABASE_POOL_MAX: '  ' })).toBeUndefined()
  })

  it('reads a positive integer', () => {
    expect(databasePoolMaxFromEnv({ DATABASE_POOL_MAX: ' 4 ' })).toBe(4)
  })

  it.each(['0', '-2', '2.5', 'five', '4x'])('rejects %p', (value) => {
    expect(() => databasePoolMaxFromEnv({ DATABASE_POOL_MAX: value })).toThrow(
      'DATABASE_POOL_MAX must be a positive integer',
    )
  })
})

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

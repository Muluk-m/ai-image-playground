import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { SQL } from 'bun'
import { eq } from 'drizzle-orm'
import { createDb, databasePoolFromEnv } from '../client'
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
  it('keeps the driver defaults unless asked: max 10, no idle timeout, no lifetime cap', () => {
    const { client } = handle()
    expect(client.options.max).toBe(10)
    expect(client.options.idleTimeout ?? 0).toBe(0)
    expect(client.options.maxLifetime ?? 0).toBe(0)
  })

  it('passes explicit pool limits to the driver', () => {
    const { client } = handle({ max: 3, idleTimeout: 5, maxLifetime: 600 })
    expect(client.options.max).toBe(3)
    expect(client.options.idleTimeout).toBe(5_000)
    expect(client.options.maxLifetime).toBe(600_000)
  })

  it('queues a burst beyond max under its application name, then closes idle connections', async () => {
    const { client } = handle({ max: 3, idleTimeout: 1, applicationName: 'aip-pool-test' })
    const burst = await Promise.all(
      Array.from(
        { length: 7 },
        () =>
          client`SELECT pg_backend_pid() AS pid, pg_sleep(0.1)` as Promise<Array<{ pid: number }>>,
      ),
    )
    expect(new Set(burst.map(([row]) => row!.pid)).size).toBe(3)

    const observer = new SQL(databaseUrl, { max: 1 })
    closeCallbacks.push(() => observer.close())
    const open = async () => {
      const [row] = await observer`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'aip-pool-test'`
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

describe('databasePoolFromEnv', () => {
  it('closes idle connections after 60 s and keeps the driver pool size when unset or blank', () => {
    const expected = { applicationName: 'aip-bff', max: undefined, idleTimeout: 60 }
    expect(databasePoolFromEnv('aip-bff', {})).toEqual(expected)
    expect(
      databasePoolFromEnv('aip-bff', { DATABASE_POOL_MAX: ' ', DATABASE_IDLE_TIMEOUT_SECONDS: '' }),
    ).toEqual(expected)
  })

  it('reads positive integers', () => {
    expect(
      databasePoolFromEnv('aip-worker', {
        DATABASE_POOL_MAX: ' 4 ',
        DATABASE_IDLE_TIMEOUT_SECONDS: '120',
      }),
    ).toEqual({ applicationName: 'aip-worker', max: 4, idleTimeout: 120 })
  })

  for (const name of ['DATABASE_POOL_MAX', 'DATABASE_IDLE_TIMEOUT_SECONDS']) {
    it.each(['0', '-2', '2.5', 'five', '4x'])(`rejects ${name}=%p`, (value) => {
      expect(() => databasePoolFromEnv('aip-bff', { [name]: value })).toThrow(
        `${name} must be a positive integer`,
      )
    })
  }
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

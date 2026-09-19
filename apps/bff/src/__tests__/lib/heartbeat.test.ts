import { afterAll, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'

const databaseUrl = await resetTestDatabase('bff_heartbeat')
process.env.DATABASE_URL = databaseUrl

const reader = createDb(databaseUrl)
const { writeHeartbeat, startHeartbeat, purgeStaleHeartbeats } = await import('../../lib/heartbeat')
const { close } = await import('../../db/client')

afterAll(async () => {
  await Promise.all([reader.close(), close()])
})

async function rows() {
  return reader.db.select().from(reader.schema.service_heartbeats)
}

describe('writeHeartbeat', () => {
  it('keeps one row per instance however many times it beats, and moves the clock forward', async () => {
    const first = Date.now() - 60_000
    await writeHeartbeat({ service: 'worker', instance: 'w-1', version: 'abc1234', now: first })
    await writeHeartbeat({
      service: 'worker',
      instance: 'w-1',
      version: 'abc1234',
      detail: { last_successful_poll_at: first + 30_000 },
      now: first + 30_000,
    })

    const all = await rows()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({
      service: 'worker',
      instance: 'w-1',
      version: 'abc1234',
      last_seen_at: first + 30_000,
      detail: { last_successful_poll_at: first + 30_000 },
    })
  })

  it('records a redeployed instance beside the old one, so the board can tell which is current', async () => {
    await writeHeartbeat({
      service: 'worker',
      instance: 'w-2',
      version: 'def5678',
      now: Date.now(),
    })
    const instances = (await rows())
      .filter((row) => row.service === 'worker')
      .map((row) => row.instance)
    expect(instances.sort()).toEqual(['w-1', 'w-2'])
  })
})

describe('purgeStaleHeartbeats', () => {
  it('drops instances that stopped beating long ago and keeps the live ones', async () => {
    const now = Date.now()
    await writeHeartbeat({
      service: 'bff',
      instance: 'gone',
      version: 'old',
      now: now - 3 * 86_400_000,
    })
    await writeHeartbeat({ service: 'bff', instance: 'live', version: 'new', now })

    await purgeStaleHeartbeats(now)

    const bff = (await rows()).filter((row) => row.service === 'bff').map((row) => row.instance)
    expect(bff).toEqual(['live'])
  })
})

describe('startHeartbeat', () => {
  it('beats at once, and a failing write never reaches the caller', async () => {
    const seen: string[] = []
    const failures: unknown[] = []
    const stop = startHeartbeat({
      service: 'worker',
      intervalMs: 5,
      write: async (beat) => {
        seen.push(beat.service)
        throw new Error('database is read-only')
      },
      onError: (error) => failures.push(error),
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    stop()
    const beatsAtStop = seen.length
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(beatsAtStop).toBeGreaterThanOrEqual(2)
    expect(failures.length).toBe(beatsAtStop)
    // 停了就真的停了：进程优雅退出时不该再有一次写库。
    expect(seen.length).toBe(beatsAtStop)
  })

  it('reads the detail fresh on every beat', async () => {
    let polls = 0
    const details: unknown[] = []
    const stop = startHeartbeat({
      service: 'worker',
      intervalMs: 5,
      detail: () => ({ polls: ++polls }),
      write: async (beat) => {
        details.push(beat.detail)
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    stop()
    expect(details[0]).toEqual({ polls: 1 })
    expect(details[1]).toEqual({ polls: 2 })
  })
})

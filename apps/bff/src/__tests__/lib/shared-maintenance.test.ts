import { afterAll, afterEach, describe, expect, it, spyOn } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { sql } from 'drizzle-orm'

process.env.DATABASE_URL = await resetTestDatabase('bff_shared_maintenance')
// These singletons must load only after DATABASE_URL points at this suite's isolated database.
const { db, close } = await import('../../db/client')
const { createSharedMaintenance, startSharedMaintenance } = await import('../../lib/shared-maintenance')
await db.execute(sql`CREATE TABLE maintenance_probe (job text NOT NULL, pid integer NOT NULL)`)

const stops: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()))
})
afterAll(close)

function runner(job: string, options: {
  work?: () => Promise<void>
  onError?: (error: unknown) => void
} = {}) {
  const maintenance = createSharedMaintenance({
    job,
    onError: options.onError,
    work: async (transaction) => {
      const [lock] = await transaction.execute<{ held: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND granted
        ) AS held
      `)
      expect(lock?.held).toBe(true)
      await transaction.execute(sql`INSERT INTO maintenance_probe VALUES (${job}, pg_backend_pid())`)
      await options.work?.()
    },
  })
  stops.push(maintenance.stop)
  return maintenance
}
function rows(job: string) {
  return db.execute<{ pid: number }>(sql`SELECT pid FROM maintenance_probe WHERE job = ${job} ORDER BY ctid`)
}

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { promise, release: resolve }
}

describe('shared maintenance leadership', () => {
  it('elects one session across competing instances and keeps leadership between transactions', async () => {
    const first = runner('competing')
    const second = runner('competing')
    await Promise.all([first.run(), second.run()])
    const initial = await rows('competing')
    expect(initial).toHaveLength(1)
    await Promise.all([first.run(), second.run()])
    const next = await rows('competing')
    expect(next).toHaveLength(2)
    expect(next[1]!.pid).toBe(initial[0]!.pid)
    const [connections] = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE application_name = 'aip-maintenance:competing'
    `)
    expect(connections?.count).toBe(1)
  })

  it('lets a different instance take over after graceful shutdown and prevents stopped runs', async () => {
    const leader = runner('shutdown')
    const follower = runner('shutdown')
    await leader.run()
    await follower.run()
    const [initial] = await rows('shutdown')
    await leader.stop()
    await leader.run()
    await follower.run()
    const next = await rows('shutdown')
    expect(next).toHaveLength(2)
    expect(next[1]!.pid).not.toBe(initial!.pid)
  })

  it('reacquires leadership after connection loss before doing any work', async () => {
    const formerLeader = runner('connection-loss')
    const follower = runner('connection-loss')
    await formerLeader.run()
    const [initial] = await rows('connection-loss')
    await db.execute(sql`SELECT pg_terminate_backend(${initial!.pid})`)
    await follower.run()
    await formerLeader.run()
    await formerLeader.run()
    const next = await rows('connection-loss')
    expect(next).toHaveLength(2)
    expect(next[1]!.pid).not.toBe(initial!.pid)
  })

  it('coalesces overlapping triggers without queuing another run and waits for work on stop', async () => {
    const entered = gate()
    const release = gate()
    let calls = 0
    const maintenance = runner('overlap', {
      work: async () => {
        calls++
        entered.release()
        await release.promise
      },
    })
    const running = maintenance.run()
    await entered.promise
    expect(maintenance.run()).toBe(running)
    expect(maintenance.run()).toBe(running)
    let stopped = false
    const stopping = maintenance.stop().then(() => { stopped = true })
    expect(stopped).toBe(false)
    release.release()
    await Promise.all([running, stopping])
    expect(calls).toBe(1)
    expect(await rows('overlap')).toHaveLength(1)
    await maintenance.run()
    expect(calls).toBe(1)
  })

  it('rolls back failed cleanup, contains the error and releases leadership for another instance', async () => {
    const errors: unknown[] = []
    const failure = new Error('cleanup unavailable')
    const failing = runner('failure', {
      work: async () => { throw failure },
      onError: (error) => { errors.push(error) },
    })
    await expect(failing.run()).resolves.toBeUndefined()
    expect(errors).toEqual([failure])
    expect(await rows('failure')).toHaveLength(0)
    const follower = runner('failure')
    await follower.run()
    expect(await rows('failure')).toHaveLength(1)
  })

  it('keeps independent maintenance jobs from blocking each other', async () => {
    const first = runner('logs-job')
    const second = runner('ops-job')
    await Promise.all([first.run(), second.run()])
    expect(await rows('logs-job')).toHaveLength(1)
    expect(await rows('ops-job')).toHaveLength(1)
  })

  it('runs startup maintenance immediately and releases its session when stopped', async () => {
    const started = gate()
    const interval = spyOn(globalThis, 'setInterval')
    const stop = startSharedMaintenance({
      job: 'startup',
      work: async (transaction) => {
        await transaction.execute(sql`INSERT INTO maintenance_probe VALUES ('startup', pg_backend_pid())`)
        started.release()
      },
    })
    stops.push(stop)
    const scheduledInterval = interval.mock.calls.at(-1)?.[1]
    interval.mockRestore()
    expect(scheduledInterval).toBe(300_000)
    await started.promise
    await stop()
    expect(await rows('startup')).toHaveLength(1)
    const successor = runner('startup')
    await successor.run()
    expect(await rows('startup')).toHaveLength(2)
  })
})

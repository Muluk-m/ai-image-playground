import { afterAll, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

process.env.DATABASE_URL = await resetTestDatabase('bff_operations_maintenance')
// These singletons must load after the suite has bound its isolated database URL.
const { db, schema, close } = await import('../../db/client')
const { purgeOldHostSamples } = await import('../../db/maintenance')
const { purgeStaleHeartbeats } = await import('../../lib/heartbeat')
const { createSharedMaintenance } = await import('../../lib/shared-maintenance')
afterAll(close)

it('cleans operations history on the leader transaction and rolls every purge back on failure', async () => {
  const now = Date.now()
  const heartbeatBoundary = now - 24 * 3600_000
  const sampleBoundary = now - 7 * 86400_000
  await db.insert(schema.service_heartbeats).values([
    {
      service: 'worker',
      instance: 'expired',
      version: 'test',
      last_seen_at: heartbeatBoundary - 1,
    },
    { service: 'worker', instance: 'retained', version: 'test', last_seen_at: heartbeatBoundary },
  ])
  await db.insert(schema.host_samples).values(
    [sampleBoundary - 1, sampleBoundary].map((sampled_at) => ({
      sampled_at,
      disk_total_bytes: 100,
      disk_available_bytes: 50,
      mem_total_bytes: 100,
      mem_available_bytes: 50,
    })),
  )
  await db.insert(schema.container_samples).values(
    [sampleBoundary - 1, sampleBoundary].map((sampled_at) => ({
      sampled_at,
      container_id: 'fixture',
      mem_bytes: 50,
      oom_kills: 0,
    })),
  )
  await db.insert(schema.api_minutes).values(
    [sampleBoundary - 1, sampleBoundary].map((minute) => ({
      minute,
      instance: 'fixture',
      requests: 1,
      client_errors: 0,
      server_errors: 0,
    })),
  )
  let fail = true
  const errors: unknown[] = []
  const maintenance = createSharedMaintenance({
    job: 'operations-history-test',
    onError: (error) => {
      errors.push(error)
    },
    work: async (transaction) => {
      await purgeStaleHeartbeats(now, transaction)
      await purgeOldHostSamples(now, transaction)
      if (fail) throw new Error('rollback all operations retention')
    },
  })
  try {
    await maintenance.run()
    expect(errors).toHaveLength(1)
    expect(await db.select().from(schema.service_heartbeats)).toHaveLength(2)
    expect(await db.select().from(schema.host_samples)).toHaveLength(2)
    expect(await db.select().from(schema.container_samples)).toHaveLength(2)
    expect(await db.select().from(schema.api_minutes)).toHaveLength(2)
    fail = false
    await maintenance.run()
    expect(errors).toHaveLength(1)
    expect((await db.select().from(schema.service_heartbeats)).map((row) => row.instance)).toEqual([
      'retained',
    ])
    expect((await db.select().from(schema.host_samples)).map((row) => row.sampled_at)).toEqual([
      sampleBoundary,
    ])
    expect((await db.select().from(schema.container_samples)).map((row) => row.sampled_at)).toEqual(
      [sampleBoundary],
    )
    expect((await db.select().from(schema.api_minutes)).map((row) => row.minute)).toEqual([
      sampleBoundary,
    ])
  } finally {
    await maintenance.stop()
  }
})

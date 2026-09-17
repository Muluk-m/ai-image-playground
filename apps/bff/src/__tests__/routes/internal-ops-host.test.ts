import { afterAll, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'

const bffRoot = resolve(import.meta.dir, '../../..')
const databaseUrl = await resetTestDatabase('bff_internal_ops_host')
process.env.PORT = '0'
process.env.DATABASE_URL = databaseUrl
process.env.OPERATOR_CONFIG_FILE = resolve(bffRoot, 'operator-config.example.json')
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'

const reader = createDb(databaseUrl)
const { app } = await import('../../app')
const { purgeOldHostSamples } = await import('../../db/maintenance')
const { close } = await import('../../db/client')

afterAll(async () => {
  await Promise.all([reader.close(), close()])
})

const GB = 1024 ** 3
const valid = {
  sampled_at: Date.now(),
  disk_total_bytes: 50 * GB,
  disk_available_bytes: 18 * GB,
  mem_total_bytes: 4 * GB,
  mem_available_bytes: 1 * GB,
}

function post(body: unknown, authorized = true): Promise<Response> {
  return app.handle(
    new Request('http://localhost/internal/admin/ops/host-samples', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorized ? { authorization: 'Bearer fixture-service-credential-alpha' } : {}),
      },
      body: JSON.stringify(body),
    }),
  )
}

describe('POST /internal/admin/ops/host-samples', () => {
  it('is closed to callers without the service credential', async () => {
    expect((await post(valid, false)).status).toBe(401)
    expect(await reader.db.select().from(reader.schema.host_samples)).toHaveLength(0)
  })

  it('stores a sample from the collector', async () => {
    expect((await post(valid)).status).toBe(204)
    const rows = await reader.db.select().from(reader.schema.host_samples)
    expect(rows).toEqual([valid])
  })

  it('takes a retried report of the same sample without failing or duplicating it', async () => {
    expect((await post({ ...valid, disk_available_bytes: 17 * GB })).status).toBe(204)
    const rows = await reader.db.select().from(reader.schema.host_samples)
    expect(rows).toHaveLength(1)
  })

  it.each([
    [
      'available above total',
      { ...valid, sampled_at: valid.sampled_at + 1, disk_available_bytes: 60 * GB },
    ],
    ['negative bytes', { ...valid, sampled_at: valid.sampled_at + 2, mem_available_bytes: -1 }],
    ['a zero-sized disk', { ...valid, sampled_at: valid.sampled_at + 3, disk_total_bytes: 0 }],
    ['a sample from the far future', { ...valid, sampled_at: Date.now() + 86_400_000 }],
    ['a missing field', { sampled_at: Date.now() }],
  ])('rejects %s', async (_name, body) => {
    expect((await post(body)).status).toBe(400)
    expect(await reader.db.select().from(reader.schema.host_samples)).toHaveLength(1)
  })
})

describe('purgeOldHostSamples', () => {
  it('keeps seven days and drops the rest, so this table never becomes the thing eating the disk', async () => {
    const now = Date.now()
    await reader.db.insert(reader.schema.host_samples).values([
      { ...valid, sampled_at: now - 8 * 86_400_000 },
      { ...valid, sampled_at: now - 6 * 86_400_000 },
    ])
    const removed = await purgeOldHostSamples(now)
    expect(removed).toBe(1)
    const kept = (await reader.db.select().from(reader.schema.host_samples)).map(
      (row) => row.sampled_at,
    )
    expect(kept).not.toContain(now - 8 * 86_400_000)
    expect(kept).toContain(now - 6 * 86_400_000)
  })
})

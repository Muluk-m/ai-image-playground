import { afterAll, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'

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
    // 旧采集容器只报这五项；后来加的几列留空。
    expect(rows).toEqual([
      {
        ...valid,
        cpu_count: null,
        cpu_busy_ratio: null,
        load_1: null,
        load_5: null,
        load_15: null,
        swap_total_bytes: null,
        swap_free_bytes: null,
        booted_at: null,
      },
    ])
  })

  it('takes a retried report of the same sample without failing or duplicating it', async () => {
    expect((await post({ ...valid, disk_available_bytes: 17 * GB })).status).toBe(204)
    const rows = await reader.db.select().from(reader.schema.host_samples)
    expect(rows).toHaveLength(1)
  })

  it('stores CPU, load, swap, boot time and every container of a newer collector', async () => {
    const sampledAt = valid.sampled_at + 100
    const body = {
      ...valid,
      sampled_at: sampledAt,
      cpu_count: 2,
      cpu_busy_ratio: 0.35,
      load_1: 0.4,
      load_5: 0.3,
      load_15: 0.2,
      swap_total_bytes: 2 * GB,
      swap_free_bytes: 2 * GB,
      booted_at: sampledAt - 3_600_000,
      containers: [
        {
          container_id: 'a'.repeat(64),
          name: 'image-playground-paid-bff-1',
          mem_bytes: 300 * 1024 ** 2,
          mem_limit_bytes: null,
          cpu_cores: 0.12,
          oom_kills: 0,
        },
      ],
    }
    expect((await post(body)).status).toBe(204)

    const [host] = await reader.db
      .select()
      .from(reader.schema.host_samples)
      .where(eq(reader.schema.host_samples.sampled_at, sampledAt))
    expect(host).toMatchObject({
      cpu_count: 2,
      cpu_busy_ratio: 0.35,
      booted_at: sampledAt - 3_600_000,
    })
    const containers = await reader.db.select().from(reader.schema.container_samples)
    expect(containers).toEqual([{ ...body.containers[0], sampled_at: sampledAt }])
    await reader.db.delete(reader.schema.container_samples)
    await reader.db
      .delete(reader.schema.host_samples)
      .where(eq(reader.schema.host_samples.sampled_at, sampledAt))
  })

  it.each([
    [
      'a container id that is not a Docker id',
      {
        ...valid,
        sampled_at: valid.sampled_at + 4,
        containers: [
          {
            container_id: '../etc',
            name: null,
            mem_bytes: 1,
            mem_limit_bytes: null,
            cpu_cores: null,
            oom_kills: 0,
          },
        ],
      },
    ],
    ['a CPU ratio above one', { ...valid, sampled_at: valid.sampled_at + 5, cpu_busy_ratio: 1.5 }],
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
    await reader.db.insert(reader.schema.container_samples).values(
      [now - 8 * 86_400_000, now - 6 * 86_400_000].map((sampled_at) => ({
        sampled_at,
        container_id: 'c'.repeat(64),
        name: null,
        mem_bytes: 1,
        oom_kills: 0,
      })),
    )
    await reader.db.insert(reader.schema.api_minutes).values(
      [now - 8 * 86_400_000, now - 6 * 86_400_000].map((minute) => ({
        minute,
        instance: 'bff-1',
        requests: 1,
        client_errors: 0,
        server_errors: 0,
      })),
    )
    const removed = await purgeOldHostSamples(now)
    expect(removed).toBe(1)
    // 容器读数与接口统计跟着宿主机采样一起过期。
    expect(await reader.db.select().from(reader.schema.container_samples)).toHaveLength(1)
    expect(await reader.db.select().from(reader.schema.api_minutes)).toHaveLength(1)
    const kept = (await reader.db.select().from(reader.schema.host_samples)).map(
      (row) => row.sampled_at,
    )
    expect(kept).not.toContain(now - 8 * 86_400_000)
    expect(kept).toContain(now - 6 * 86_400_000)
  })
})

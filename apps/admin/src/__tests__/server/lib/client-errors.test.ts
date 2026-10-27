import { afterAll, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'

const TEST_DB = await resetTestDatabase('admin_client_errors')
process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = TEST_DB
process.env.BFF_INTERNAL_URL = 'http://127.0.0.1:39999'
process.env.PORT = '0'

const writer = createDb(TEST_DB)
const now = Date.now()
const hourMs = 3600_000
const row = (
  id: string,
  fingerprint: string,
  kind: 'boot' | 'error',
  hoursAgo: number,
  device: string,
) => ({
  id,
  fingerprint,
  kind,
  message: kind === 'boot' ? 'timeout' : `bad ${id}`,
  name: kind === 'boot' ? 'BootFailure' : 'TypeError',
  received_at: now - hoursAgo * hourMs,
  device_id: device,
  release: `build-${id}`,
})
await writer.db.insert(writer.schema.client_errors).values([
  row('a1', 'aaaaaaaaaaaaaaaa', 'boot', 1, 'dev-1'),
  row('a2', 'aaaaaaaaaaaaaaaa', 'boot', 2, 'dev-2'),
  row('a3', 'aaaaaaaaaaaaaaaa', 'boot', 3, 'dev-2'),
  row('b1', 'bbbbbbbbbbbbbbbb', 'error', 0.5, 'dev-1'),
  row('c1', 'cccccccccccccccc', 'error', 24 * 10, 'dev-3'),
  // 窗口起点所在的那个小时里、但早于窗口的事件：趋势不能把它算进去。
  row('d1', 'dddddddddddddddd', 'error', 24.2, 'dev-4'),
])

const { getClientErrors, getClientErrorEvents } = await import(
  '../../../../server/lib/client-errors'
)

afterAll(async () => {
  await writer.close()
})

describe('client error dashboard queries', () => {
  it('groups the window by fingerprint, most frequent first', async () => {
    const result = await getClientErrors('1d')
    expect(result.summary).toEqual({ events: 4, devices: 2, boot_events: 3, groups: 2 })
    expect(result.groups.map((group) => [group.fingerprint, group.count, group.devices])).toEqual([
      ['aaaaaaaaaaaaaaaa', 3, 2],
      ['bbbbbbbbbbbbbbbb', 1, 1],
    ])
    expect(result.groups[0]).toMatchObject({
      kind: 'boot',
      message: 'timeout',
      last_release: 'build-a1',
    })
    expect(result.trend.length).toBeGreaterThanOrEqual(24)
    const totals = result.trend.reduce((sum, bucket) => sum + bucket.boot + bucket.runtime, 0)
    expect(totals).toBe(4)
    expect((await getClientErrors('30d')).summary.groups).toBe(4)
  })

  it('lists the latest events of one problem', async () => {
    const result = await getClientErrorEvents('aaaaaaaaaaaaaaaa', '1d')
    expect(result.events.map((event) => event.id)).toEqual(['a1', 'a2', 'a3'])
  })
})

it('labels mixed sources without hiding them and only accepts exact recovery evidence', async () => {
  const fingerprint = 'eeeeeeeeeeeeeeee'
  const incidentId = '10000000-0000-4000-8000-000000000001'
  const operation = 'canvas.scene.save'
  const errorTime = now - hourMs / 4
  const cases = [
    { id: 'local', url: 'http://127.0.0.1:4173/assets', user_agent: 'HeadlessChrome/145' },
    { id: 'ipv6', url: 'http://[::1]:4173/image' },
    { id: 'automated', url: 'https://studio.example/image', user_agent: 'HeadlessChrome/145' },
    { id: 'marked', message: 'p2_synthetic_quota_failure' },
    { id: 'ordinary', url: 'https://studio.example/image', user_agent: 'Chrome/132' },
    { id: 'lookalike', url: 'https://localhost.example/image' },
    { id: 'wrong-operation', context: { incidentId, operation: 'media.upload' } },
  ]
  await writer.db.insert(writer.schema.client_errors).values(
    cases.map((entry) => ({
      ...row(entry.id, fingerprint, 'error', 0.25, 'recovery-device'),
      user_id: entry.id === 'lookalike' ? 'other-user' : 'recovery-user',
      context: {
        incidentId: entry.id === 'ordinary' ? 'different-incident' : incidentId,
        operation,
      },
      ...entry,
    })),
  )
  await writer.db.insert(writer.schema.client_error_recoveries).values([
    {
      id: 'matching',
      incident_id: incidentId,
      operation,
      device_id: 'recovery-device',
      user_id: 'recovery-user',
      received_at: errorTime - 1000,
    },
    {
      id: 'wrong-device',
      incident_id: 'different-incident',
      operation,
      device_id: 'other-device',
      user_id: 'recovery-user',
      received_at: errorTime + 1000,
    },
    {
      id: 'unsupported',
      incident_id: incidentId,
      operation: 'media.upload',
      device_id: 'recovery-device',
      user_id: 'recovery-user',
      received_at: errorTime + 1000,
    },
  ])
  try {
    const result = await getClientErrors('1d')
    const group = result.groups.find((entry) => entry.fingerprint === fingerprint)
    expect(group).toMatchObject({
      count: 7,
      sources: { local: 2, automation: 1, marked_test: 1, unclassified: 3 },
      recovered: 4,
    })
    expect(result.summary.events).toBe(11)
    expect(result.trend.reduce((sum, bucket) => sum + bucket.boot + bucket.runtime, 0)).toBe(11)
    const { events } = await getClientErrorEvents(fingerprint, '1d')
    expect(events).toHaveLength(7)
    for (const id of ['local', 'ipv6', 'automated', 'marked']) {
      expect(events.find((event) => event.id === id)?.recovered_at).toBe(errorTime)
    }
    for (const id of ['ordinary', 'lookalike', 'wrong-operation']) {
      expect(events.find((event) => event.id === id)?.recovered_at).toBeNull()
    }
    expect(events.find((event) => event.id === 'lookalike')?.source).toBe('unclassified')
  } finally {
    const { inArray } = await import('drizzle-orm')
    await writer.db.delete(writer.schema.client_errors).where(
      inArray(
        writer.schema.client_errors.id,
        cases.map((entry) => entry.id),
      ),
    )
    await writer.db
      .delete(writer.schema.client_error_recoveries)
      .where(
        inArray(writer.schema.client_error_recoveries.id, [
          'matching',
          'wrong-device',
          'unsupported',
        ]),
      )
  }
})

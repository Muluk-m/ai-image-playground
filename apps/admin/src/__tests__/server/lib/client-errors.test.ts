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
await writer.db
  .insert(writer.schema.client_errors)
  .values([
    row('a1', 'aaaaaaaaaaaaaaaa', 'boot', 1, 'dev-1'),
    row('a2', 'aaaaaaaaaaaaaaaa', 'boot', 2, 'dev-2'),
    row('a3', 'aaaaaaaaaaaaaaaa', 'boot', 3, 'dev-2'),
    row('b1', 'bbbbbbbbbbbbbbbb', 'error', 0.5, 'dev-1'),
    row('c1', 'cccccccccccccccc', 'error', 24 * 10, 'dev-3'),
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
    expect(result.trend).toHaveLength(24)
    const totals = result.trend.reduce((sum, bucket) => sum + bucket.boot + bucket.runtime, 0)
    expect(totals).toBe(4)
    expect((await getClientErrors('30d')).summary.groups).toBe(3)
  })

  it('lists the latest events of one problem', async () => {
    const result = await getClientErrorEvents('aaaaaaaaaaaaaaaa', '1d')
    expect(result.events.map((event) => event.id)).toEqual(['a1', 'a2', 'a3'])
  })
})

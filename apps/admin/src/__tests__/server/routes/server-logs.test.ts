import { afterAll, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { ServerLogsResult } from '@image-playground/shared'

process.env.DATABASE_URL = await resetTestDatabase('admin_server_logs')
process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
const writer = createDb(process.env.DATABASE_URL)
const now = Date.now()
const rows = Array.from({ length: 105 }, (_, index) => ({
  id: `entry-${String(index).padStart(3, '0')}`,
  at: now - 60_000,
  service: 'bff' as const,
  instance: 'old-container',
  version: 'old-release',
  level: 'error' as const,
  event: 'task.failed',
  group_key: 'task.failed',
  message: index === 0 ? 'literal 100%_failure' : 'task failed',
  request_id: `request-${index}`,
  task_id: 'task-1',
  fields: { err: { stack: 'at worker.ts:42' } },
}))
await writer.db.insert(writer.schema.server_logs).values([
  ...rows,
  {
    ...rows[0]!,
    id: 'worker-info',
    service: 'worker',
    level: 'info',
    event: 'worker.ready',
    group_key: 'worker.ready',
    message: 'worker ready',
    request_id: null,
  },
  { ...rows[0]!, id: 'outside-window', at: now - 2 * 3600_000 },
])
await writer.db.insert(writer.schema.service_heartbeats).values([
  {
    service: 'bff',
    instance: 'live-collector',
    version: 'new-release',
    last_seen_at: now,
    detail: { logs: { pending: 3, dropped: 0, failures: 1, last_written_at: now - 2000 } },
  },
  {
    service: 'bff',
    instance: 'retired-collector',
    version: 'old-release',
    last_seen_at: now - 3600_000,
    detail: { logs: { pending: 0, dropped: 0, failures: 0, last_written_at: now - 3600_000 } },
  },
  {
    service: 'worker',
    instance: 'stale-worker',
    version: 'old-release',
    last_seen_at: now - 3600_000,
    detail: { logs: { pending: 5, dropped: 2, failures: 4, last_written_at: now - 3600_000 } },
  },
])
const { app } = await import('../../../../server/app')
const loginResponse = await app.handle(
  new Request('http://localhost/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.198' },
    body: JSON.stringify({ password: 'test-pass-1234' }),
  }),
)
const cookie = loginResponse.headers.get('set-cookie')!.split(';')[0]!
const base = `/api/ops/logs?from=${now - 3600_000}&to=${now}`
async function request(extra = '') {
  return app.handle(new Request(`http://localhost${base}${extra}`, { headers: { cookie } }))
}
afterAll(() => writer.close())

describe('authenticated server log explorer', () => {
  it('requires an operator session and validates expensive or malformed queries', async () => {
    expect((await app.handle(new Request(`http://localhost${base}`))).status).toBe(401)
    for (const extra of [
      '&level=bad',
      '&service=admin',
      '&cursor=broken',
      `&from=${now - 8 * 86400_000}`,
      `&to=${now - 2 * 3600_000}`,
    ])
      expect((await request(extra)).status).toBe(400)
  })
  it('reads logs across old instances with matching aggregates and gap-filled trend', async () => {
    const result = (await (await request()).json()) as ServerLogsResult
    expect(result.entries).toHaveLength(100)
    expect(result.summary).toEqual({ total: 106, errors: 105, warnings: 0 })
    expect(result.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'task.failed', count: 105 }),
        expect.objectContaining({ service: 'worker', count: 1 }),
      ]),
    )
    expect(result.trend.reduce((sum, point) => sum + point.count, 0)).toBe(106)
    expect(result.trend.some((point) => point.count === 0)).toBe(true)
    expect(result.entries[0]!.at).toBe(now - 60_000)
    expect(result.entries[0]!.fields).toEqual(rows[0]!.fields)
    expect(result.collectors.map((collector) => collector.instance)).toEqual([
      'live-collector',
      'stale-worker',
    ])
    expect(result.collectors[0]).toMatchObject({
      pending: 3,
      failures: 1,
      last_seen_at: now,
      last_written_at: now - 2000,
    })
  })
  it('paginates equal timestamps without skips or duplicates; aggregates cover the whole filter', async () => {
    const first = (await (await request('&service=bff&level=error')).json()) as ServerLogsResult
    const second = (await (
      await request(`&service=bff&level=error&cursor=${first.nextCursor}`)
    ).json()) as ServerLogsResult
    const ids = [...first.entries, ...second.entries].map((row) => row.id)
    expect(new Set(ids).size).toBe(105)
    expect(ids).toHaveLength(105)
    expect(second.nextCursor).toBeNull()
    expect(second.summary.total).toBe(105)
  })
  it('supports literal search and exact request, task and event drill-down', async () => {
    const literal = (await (await request('&q=100%25_failure')).json()) as ServerLogsResult
    expect(literal.summary.total).toBe(1)
    const correlated = (await (
      await request('&requestId=request-5&taskId=task-1&group=task.failed')
    ).json()) as ServerLogsResult
    expect(correlated.entries.map((row) => row.id)).toEqual(['entry-005'])
    const injection = (await (await request('&q=%27%20OR%201%3D1--')).json()) as ServerLogsResult
    expect(injection.summary.total).toBe(0)
  })
})

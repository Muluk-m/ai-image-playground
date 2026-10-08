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
  fields: {
    err: { stack: 'at worker.ts:42' },
    userId: index === 5 ? 'user-a' : 'user-b',
    mediaId: `media-${index}`,
  },
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
      '&service=not-a-service',
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
    expect(result.coverage).toEqual({ first_at: now - 2 * 3600_000, last_at: now - 60000 })
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
    expect(second).not.toHaveProperty('summary')
    expect(second).not.toHaveProperty('groups')
    expect(second).not.toHaveProperty('trend')
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
  it('filters exact user, media, instance and version without crossing user boundaries', async () => {
    const matched = (await (
      await request('&userId=user-a&mediaId=media-5&instance=old-container&version=old-release')
    ).json()) as ServerLogsResult
    expect(matched.entries.map((row) => row.id)).toEqual(['entry-005'])
    expect(matched.summary.total).toBe(1)
    const other = (await (
      await request('&userId=user-b&mediaId=media-5')
    ).json()) as ServerLogsResult
    expect(other.summary.total).toBe(0)
    expect(other.coverage).toEqual(matched.coverage)
    expect((await request('&instance=' + 'x'.repeat(401))).status).toBe(400)
  })
  it('counts levels independently of the selected level and rejects invalid stream or deployment', async () => {
    const result = (await (await request('&level=error')).json()) as ServerLogsResult
    expect(result.levelCounts).toEqual({ error: 105, info: 1 })
    expect(result.entries.every((entry) => entry.level === 'error')).toBe(true)
    expect((await request('&stream=bad')).status).toBe(400)
    expect((await request('&deployment=bad')).status).toBe(400)
  })
  it('reads at most 50 neighbors on each side from the selected container', async () => {
    const url = 'http://localhost/api/ops/logs/context?id=entry-050'
    expect((await app.handle(new Request(url))).status).toBe(401)
    const response = await app.handle(new Request(url, { headers: { cookie } }))
    const context = (await response.json()) as { entries: Array<{ id: string; instance: string }> }
    expect(context.entries).toHaveLength(101)
    expect(context.entries.some((entry) => entry.id === 'entry-050')).toBe(true)
    expect(new Set(context.entries.map((entry) => entry.id)).size).toBe(101)
    expect(context.entries.every((entry) => entry.instance === 'old-container')).toBe(true)
    expect(
      (
        await app.handle(
          new Request('http://localhost/api/ops/logs/context?id=bad%27id', { headers: { cookie } }),
        )
      ).status,
    ).toBe(400)
    const missing = await app.handle(
      new Request('http://localhost/api/ops/logs/context?id=missing', { headers: { cookie } }),
    )
    expect(await missing.json()).toEqual({ entries: [] })
  })
  it('filters container streams and deployment identity', async () => {
    await writer.db.insert(writer.schema.server_logs).values({
      ...rows[0]!,
      id: 'container-stderr',
      service: 'admin',
      level: 'warn',
      instance: 'image-playground-paid-admin-1',
      fields: { stream: 'stderr' },
    })
    const result = (await (
      await request('&stream=stderr&deployment=paid')
    ).json()) as ServerLogsResult
    expect(result.entries.map((entry) => entry.id)).toEqual(['container-stderr'])
    const other = (await (
      await request('&stream=stderr&deployment=test')
    ).json()) as ServerLogsResult
    expect(other.entries).toHaveLength(0)
  })
  it('uses the same legacy-frame severity in filters, rows, counts, groups and trends', async () => {
    await writer.db.insert(writer.schema.server_logs).values([
      {
        ...rows[0]!,
        id: 'legacy-frame-stderr',
        instance: 'legacy-fixture',
        event: null,
        message: '    at call (app.ts:1)',
        fields: { stream: 'stderr' },
      },
      {
        ...rows[0]!,
        id: 'legacy-frame-stdout',
        instance: 'legacy-fixture',
        event: null,
        message: '    at other (app.ts:2)',
        fields: { stream: 'stdout' },
      },
      {
        ...rows[0]!,
        id: 'whole-error',
        instance: 'legacy-fixture',
        event: null,
        message: 'TypeError: broken\n    at call (app.ts:1)',
        fields: { stream: 'stderr' },
      },
    ])
    const all = (await (await request('&instance=legacy-fixture')).json()) as ServerLogsResult
    expect(all.summary).toEqual({ total: 3, errors: 1, warnings: 1 })
    expect(all.levelCounts).toEqual({ error: 1, warn: 1, info: 1 })
    expect(all.entries.find((row) => row.id === 'legacy-frame-stderr')?.level).toBe('warn')
    expect(all.entries.find((row) => row.id === 'legacy-frame-stdout')?.level).toBe('info')
    expect(
      all.groups
        .filter((group) => group.level === 'error')
        .reduce((n, group) => n + group.count, 0),
    ).toBe(1)
    expect(all.trend.reduce((n, point) => n + point.errors, 0)).toBe(1)
    const errors = (await (
      await request('&instance=legacy-fixture&level=error')
    ).json()) as ServerLogsResult
    expect(errors.entries.map((row) => row.id)).toEqual(['whole-error'])
    expect(errors.summary.errors).toBe(1)
    const contextResponse = await app.handle(
      new Request('http://localhost/api/ops/logs/context?id=legacy-frame-stderr', {
        headers: { cookie },
      }),
    )
    const context = (await contextResponse.json()) as { entries: ServerLogsResult['entries'] }
    expect(context.entries.find((row) => row.id === 'legacy-frame-stderr')?.level).toBe('warn')
    expect(context.entries.find((row) => row.id === 'legacy-frame-stdout')?.level).toBe('info')
    expect(context.entries.find((row) => row.id === 'whole-error')?.level).toBe('error')
  })
})

import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { ObsClient, ObsRecord, ObsSearch } from '@image-playground/node-kit'
import type { ServerLogsResult } from '@image-playground/shared'

process.env.DATABASE_URL = await resetTestDatabase('admin_server_logs')
process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
delete process.env.OBS_PROXY_URL
delete process.env.OBS_PROXY_TOKEN
const writer = createDb(process.env.DATABASE_URL)
const now = Date.now()
const us = (ms: number) => ms * 1_000

await writer.db.insert(writer.schema.service_heartbeats).values([
  {
    service: 'bff',
    instance: 'live-collector',
    version: 'new-release',
    last_seen_at: now,
    detail: { logs: { pending: 3, dropped: 0, failures: 1, last_written_at: now - 2000 } },
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
const { _setObsClientForTesting, logWhere, toEntry } = await import(
  '../../../../server/lib/server-logs'
)
const loginResponse = await app.handle(
  new Request('http://localhost/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.198' },
    body: JSON.stringify({ password: 'test-pass-1234' }),
  }),
)
const cookie = loginResponse.headers.get('set-cookie')!.split(';')[0]!
const base = `/api/ops/logs?from=${now - 3600_000}&to=${now}`
async function request(path: string) {
  return app.handle(new Request(`http://localhost${path}`, { headers: { cookie } }))
}
afterAll(() => writer.close())

const hit = (index: number, extra: ObsRecord = {}): ObsRecord => ({
  _timestamp: us(now - 60_000),
  body: `task failed ${index}`,
  service: 'bff',
  instance: 'bb272d8bb3c5',
  version: 'release-a',
  event: 'task.failed',
  severity: 'ERROR',
  severity_number: 17,
  requestid: `request-${index}`,
  taskid: 'task-1',
  userid: 'user-a',
  trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
  container_name: '/image-playground-paid-bff',
  fluent_tag: 'x.stdout',
  ...extra,
})

/** 按 SQL 的形状回不同的结果，并记下每次查询。 */
const searches: ObsSearch[] = []
let pageHits: ObsRecord[] = []
let traceHits: ObsRecord[] = []
const fake: ObsClient = {
  async search(query) {
    searches.push(query)
    if (query.sql.startsWith('SELECT COUNT(*) AS total'))
      return [{ total: 106, errors: 105, warnings: 0 }]
    if (query.sql.startsWith('SELECT service,'))
      return [
        {
          service: 'bff',
          level: 'error',
          key: 'task.failed',
          count: 105,
          first_at: us(now - 120_000),
          last_at: us(now - 60_000),
        },
        {
          service: 'obs-proxy',
          level: 'info',
          key: 'x',
          count: 1,
          first_at: us(now),
          last_at: us(now),
        },
      ]
    if (query.sql.startsWith('SELECT CAST(_timestamp'))
      return [{ bucket: us(Math.floor((now - 60_000) / 60_000) * 60_000), count: 106, errors: 105 }]
    if (query.sql.startsWith('SELECT CASE'))
      return [
        { level: 'error', count: 105 },
        { level: 'info', count: 1 },
      ]
    return pageHits.slice(query.from ?? 0, (query.from ?? 0) + (query.size ?? 1_000))
  },
  async searchAll(query) {
    searches.push({ ...query })
    return { records: traceHits, truncated: false }
  },
}

beforeEach(() => {
  searches.length = 0
  pageHits = Array.from({ length: 105 }, (_, index) => hit(index))
  _setObsClientForTesting(fake)
})

describe('server log explorer on OpenObserve', () => {
  it('requires an operator session and validates expensive or malformed queries', async () => {
    expect((await app.handle(new Request(`http://localhost${base}`))).status).toBe(401)
    for (const extra of [
      '&level=bad',
      '&service=not-a-service',
      '&cursor=broken',
      `&from=${now - 8 * 86400_000}`,
      `&to=${now - 2 * 3600_000}`,
      '&stream=bad',
      '&deployment=internal',
      `&instance=${'x'.repeat(401)}`,
    ])
      expect((await request(`${base}${extra}`)).status).toBe(400)
    expect(searches).toEqual([])
  })

  it('says observability is off instead of failing when the deployment has no OpenObserve', async () => {
    _setObsClientForTesting(null)
    for (const path of [
      base,
      `/api/ops/logs/context?id=1-YQ-00000000`,
      '/api/ops/traces/4bf92f3577b34da6a3ce929d0e0e4736',
    ]) {
      const response = await request(path)
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ code: 'observability_off' })
    }
  })

  it('maps records, aggregates and the gap-filled trend into the existing page shape', async () => {
    const result = (await (await request(base)).json()) as ServerLogsResult
    expect(result.entries).toHaveLength(100)
    expect(result.nextCursor).not.toBeNull()
    expect(result.summary).toEqual({ total: 106, errors: 105, warnings: 0 })
    expect(result.levelCounts).toEqual({ error: 105, info: 1 })
    expect(result.groups[0]).toEqual({
      service: 'bff',
      level: 'error',
      key: 'task.failed',
      count: 105,
      first_at: now - 120_000,
      last_at: now - 60_000,
    })
    expect(result.groups[1]?.service).toBe('other')
    expect(result.trend.reduce((sum, point) => sum + point.count, 0)).toBe(106)
    expect(result.trend.some((point) => point.count === 0)).toBe(true)
    expect(result.collectors.map((collector) => collector.instance)).toEqual([
      'live-collector',
      'stale-worker',
    ])
    expect(result.entries[0]).toMatchObject({
      at: now - 60_000,
      service: 'bff',
      level: 'error',
      event: 'task.failed',
      group_key: 'task.failed',
      message: 'task failed 0',
      request_id: 'request-0',
      task_id: 'task-1',
      fields: { userId: 'user-a', trace_id: '4bf92f3577b34da6a3ce929d0e0e4736' },
    })
    // OpenObserve 与 Collector 的元数据不进 fields。
    expect(result.entries[0]!.fields).not.toHaveProperty('container_name')
    expect(result.entries[0]!.fields).not.toHaveProperty('fluent_tag')
    // 查询范围就是页面选的时间段。
    expect(searches.every((s) => s.startMs === now - 3600_000 && s.endMs === now)).toBe(true)
  })

  it('pages by offset with a stable order and keeps statistics on the first page only', async () => {
    const first = (await (await request(base)).json()) as ServerLogsResult
    const second = (await (await request(`${base}&cursor=${first.nextCursor}`)).json()) as
      | ServerLogsResult
      | { entries: ServerLogsResult['entries']; nextCursor: null }
    const ids = [...first.entries, ...second.entries].map((row) => row.id)
    expect(new Set(ids).size).toBe(105)
    expect(second.nextCursor).toBeNull()
    expect(second).not.toHaveProperty('summary')
    const page = searches.filter((s) => s.sql.startsWith('SELECT * FROM'))
    expect(page.at(-1)).toMatchObject({ from: 100, size: 101 })
    expect(page.at(-1)?.sql).toContain('ORDER BY _timestamp DESC, instance, body')
  })

  it('turns every filter into an exact OpenObserve condition and keeps quotes literal', () => {
    const { base: clauses, level } = logWhere({
      from: 0,
      to: 1,
      service: 'worker',
      deployment: 'paid',
      stream: 'stderr',
      requestId: 'r',
      taskId: 't',
      traceId: 'tr',
      userId: 'u',
      mediaId: 'm',
      instance: 'i',
      version: 'v',
      group: 'g',
      q: "' OR 1=1--",
      level: 'warn',
    })
    expect(clauses).toEqual([
      "service = 'worker'",
      "deployment_environment_name = 'image-playground-paid'",
      "source = 'stderr'",
      "requestid = 'r'",
      "taskid = 't'",
      "trace_id = 'tr'",
      "userid = 'u'",
      "mediaid = 'm'",
      "instance = 'i'",
      "version = 'v'",
      "COALESCE(event, substr(body, 1, 120)) = 'g'",
      "(str_match_ignore_case(body, ''' OR 1=1--') OR str_match_ignore_case(event, ''' OR 1=1--') OR requestid = ''' OR 1=1--' OR taskid = ''' OR 1=1--' OR trace_id = ''' OR 1=1--')",
    ])
    expect(level).toBe('COALESCE(severity_number, 9) >= 13 AND COALESCE(severity_number, 9) < 17')
    expect(logWhere({ from: 0, to: 1, service: 'other' }).base[0]).toContain('NOT IN (')
  })

  it('counts levels without the selected level, so the level chips keep their totals', async () => {
    await request(`${base}&level=error&taskId=task-1`)
    const facet = searches.find((s) => s.sql.startsWith('SELECT CASE'))!
    expect(facet.sql).toContain("taskid = 'task-1'")
    expect(facet.sql).not.toContain('< 21')
    const page = searches.find((s) => s.sql.startsWith('SELECT * FROM'))!
    expect(page.sql).toContain('COALESCE(severity_number, 9) >= 17')
  })

  it('reads up to 50 neighbors on each side of a line from the same container', async () => {
    const entry = toEntry(hit(7))
    const before = Array.from({ length: 50 }, (_, i) =>
      hit(100 + i, { _timestamp: us(now - 61_000 - i) }),
    )
    const after = [hit(200, { _timestamp: us(now - 59_000) })]
    const context: ObsClient = {
      ...fake,
      async search(query) {
        searches.push(query)
        if (query.sql.includes('_timestamp <')) return before
        if (query.sql.includes('_timestamp =')) return [hit(7)]
        return after
      },
    }
    _setObsClientForTesting(context)
    const url = `/api/ops/logs/context?id=${entry.id}`
    expect((await app.handle(new Request(`http://localhost${url}`))).status).toBe(401)
    const result = (await (await request(url)).json()) as { entries: ServerLogsResult['entries'] }
    expect(result.entries).toHaveLength(52)
    expect(result.entries[50]?.id).toBe(entry.id)
    // 前面的按时间正序排回来。
    expect(result.entries[0]?.at).toBeLessThan(result.entries[49]!.at)
    expect(searches.every((s) => s.sql.includes("instance = 'bb272d8bb3c5'"))).toBe(true)
    expect(searches.every((s) => s.size === 50)).toBe(true)
    expect((await request("/api/ops/logs/context?id=bad'id")).status).toBe(400)
  })

  it('draws the span tree of a trace and rejects anything that is not a trace id', async () => {
    traceHits = [
      {
        span_id: 'a',
        reference_parent_span_id: '',
        start_time: 1_000_000_000,
        duration: 2_000,
        service_name: 'worker',
        operation_name: 'task.execute',
      },
      {
        span_id: 'b',
        reference_parent_span_id: 'a',
        start_time: 1_001_000_000,
        duration: 1_000,
        service_name: 'worker',
        operation_name: 'upstream POST',
      },
    ]
    const response = await request('/api/ops/traces/4bf92f3577b34da6a3ce929d0e0e4736')
    const trace = (await response.json()) as { tree: string; spans: number; truncated: boolean }
    expect(trace.spans).toBe(2)
    expect(trace.tree).toContain('worker task.execute')
    expect(trace.tree).toContain('  worker upstream POST')
    expect(searches.at(-1)).toMatchObject({ type: 'traces' })
    expect((await request('/api/ops/traces/not-a-trace')).status).toBe(400)
  })
})

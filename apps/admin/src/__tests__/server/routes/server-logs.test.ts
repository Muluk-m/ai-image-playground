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
const { _setObsClientForTesting, logSql, logWhere, toEntry } = await import(
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

/** 流里已有的字段：没有 err_stack，验证缺字段时不引用它。 */
const SCHEMA = new Set([
  '_timestamp',
  'body',
  'service',
  'instance',
  'container_name',
  'version',
  'event',
  'severity_number',
  'requestid',
  'taskid',
  'trace_id',
  'userid',
  'mediaid',
  'source',
  'deployment_environment_name',
])
const exprs = logSql(SCHEMA)
const keyOf = (index: number) => index.toString(16).padStart(32, '0')

/** 同一时刻、同一实例、同样的正文，只有请求不同：排序键（log_key）把它们分开。 */
const hit = (index: number, extra: ObsRecord = {}): ObsRecord => ({
  _timestamp: us(now - 60_000),
  body: 'task failed',
  service: 'bff',
  log_service: 'bff',
  instance: 'bb272d8bb3c5',
  log_instance: 'bb272d8bb3c5',
  log_key: keyOf(index),
  log_group: 'task.failed',
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
    if (query.sql.includes(' AS key, COUNT(*)'))
      return [
        {
          service: 'bff',
          level: 'error',
          key: 'task.failed',
          count: 105,
          first_at: us(now - 120_000),
          last_at: us(now - 60_000),
        },
      ]
    if (query.sql.startsWith('SELECT CAST(_timestamp'))
      return [{ bucket: us(Math.floor((now - 60_000) / 60_000) * 60_000), count: 106, errors: 105 }]
    if (query.sql.includes(' AS level, COUNT(*) AS count FROM'))
      return [
        { level: 'error', count: 105 },
        { level: 'info', count: 1 },
      ]
    // 记录：第二页按游标条件取剩下的。
    const rest = query.sql.includes('(_timestamp < ') ? pageHits.slice(100) : pageHits
    return rest.slice(0, query.size ?? 1_000)
  },
  async searchAll(query) {
    searches.push({ ...query })
    return { records: traceHits, truncated: false }
  },
  async streamFields() {
    return SCHEMA
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
      `&cursor=${toEntry(hit(1, { _timestamp: us(now - 2 * 3600_000) })).id}`,
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
      `/api/ops/logs/context?id=${toEntry(hit(1)).id}`,
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
    // 同一时刻同样正文、不同请求的行，id 各不相同。
    expect(new Set(result.entries.map((entry) => entry.id)).size).toBe(100)
    expect(result.nextCursor).toBe(result.entries[99]!.id)
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
      message: 'task failed',
      request_id: 'request-0',
      task_id: 'task-1',
      fields: { userId: 'user-a', trace_id: '4bf92f3577b34da6a3ce929d0e0e4736' },
    })
    // OpenObserve 与 Collector 的元数据不进 fields；容器名留着，纯文本行靠它认出是哪个容器。
    expect(result.entries[0]!.fields).not.toHaveProperty('fluent_tag')
    expect(result.entries[0]!.fields).not.toHaveProperty('log_key')
    expect(result.entries[0]!.fields).toHaveProperty('container_name')
    // 查询范围就是页面选的时间段。
    expect(searches.every((s) => s.startMs === now - 3600_000 && s.endMs === now)).toBe(true)
  })

  it('pages by the sort key, so lines written meanwhile neither repeat nor go missing', async () => {
    const first = (await (await request(base)).json()) as ServerLogsResult
    const second = (await (await request(`${base}&cursor=${first.nextCursor}`)).json()) as {
      entries: ServerLogsResult['entries']
      nextCursor: string | null
    }
    const ids = [...first.entries, ...second.entries].map((row) => row.id)
    expect(new Set(ids).size).toBe(105)
    expect(second.nextCursor).toBeNull()
    expect(second).not.toHaveProperty('summary')
    const page = searches.filter((s) => s.sql.startsWith('SELECT *,')).at(-1)!
    const ts = us(now - 60_000)
    expect(page.sql).toContain(
      `(_timestamp < ${ts} OR (_timestamp = ${ts} AND (COALESCE(instance, container_name) > 'bb272d8bb3c5' OR (COALESCE(instance, container_name) = 'bb272d8bb3c5' AND ${exprs.key} > '${keyOf(99)}'))))`,
    )
    expect(page.sql).toContain('ORDER BY _timestamp DESC, log_instance, log_key')
  })

  it('turns every filter into an exact OpenObserve condition and keeps quotes literal', () => {
    const { base: clauses, level } = logWhere(
      {
        from: 0,
        to: 1,
        service: 'router',
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
      },
      exprs,
    )
    expect(clauses[0]).toBe(`${exprs.service} = 'router'`)
    // 发布路由在 OpenObserve 里叫 release-router，按 router 筛也要查得到。
    expect(exprs.service).toContain("WHEN service = 'release-router' THEN 'router'")
    expect(clauses.slice(1, 11)).toEqual([
      "deployment_environment_name = 'image-playground-paid'",
      "source = 'stderr'",
      "requestid = 'r'",
      "taskid = 't'",
      "trace_id = 'tr'",
      "userid = 'u'",
      "mediaid = 'm'",
      "COALESCE(instance, container_name) = 'i'",
      "version = 'v'",
      `${exprs.group} = 'g'`,
    ])
    // 关键词按子串搜消息和常用字段；schema 里没有的（err_stack）不引用。
    expect(clauses[11]).toContain("str_match_ignore_case(userid, ''' OR 1=1--')")
    expect(clauses[11]).toContain("str_match_ignore_case(body, ''' OR 1=1--')")
    expect(clauses[11]).not.toContain('err_stack')
    expect(level).toBe('COALESCE(severity_number, 9) >= 13 AND COALESCE(severity_number, 9) < 17')
  })

  it('keys rows on the Collector log_id when the stream has it, and on a wide hash before that', () => {
    expect(exprs.key).toBe(
      "COALESCE(NULL, md5(concat(body, '|', requestid, '|', taskid, '|', event, '|', CAST(severity_number AS VARCHAR), '|', NULL, '|', source)))",
    )
    const withIds = logSql(new Set([...SCHEMA, 'log_id', 'span_id']))
    expect(withIds.key.startsWith('COALESCE(log_id, md5(')).toBe(true)
    const uuid = '0b6f1c2e-9a43-4d1e-8f2a-1c3d5e7f9a0b'
    const entry = toEntry(hit(1, { log_key: uuid, log_id: uuid }))
    expect(entry.id.endsWith(`-${uuid}`)).toBe(true)
    expect(entry.fields).not.toHaveProperty('log_id')
  })

  it('never references a field the stream does not have', () => {
    const bare = logSql(new Set(['_timestamp', 'body', 'service', 'container_name']))
    const { base: clauses } = logWhere({ from: 0, to: 1, taskId: 't', q: 'x' }, bare)
    expect(clauses[0]).toBe('1 = 0')
    expect(clauses[1]).toBe(
      "(str_match_ignore_case(body, 'x') OR str_match_ignore_case(container_name, 'x'))",
    )
    expect(bare.record).not.toMatch(/\b(event|requestid|taskid|instance|severity_number)\b/)
  })

  it('normalizes ids in groups with real word boundaries', () => {
    expect(exprs.group).toContain(String.raw`'(?i)\b[0-9a-f]{8}-[0-9a-f-]{27,}\b'`)
    expect(exprs.group).not.toContain('\u0008')
  })

  it('counts levels without the selected level, so the level chips keep their totals', async () => {
    await request(`${base}&level=error&taskId=task-1`)
    const facet = searches.find((s) => s.sql.includes(' AS level, COUNT(*) AS count FROM'))!
    expect(facet.sql).toContain("taskid = 'task-1'")
    expect(facet.sql).not.toContain('< 21')
    const page = searches.find((s) => s.sql.startsWith('SELECT *,'))!
    expect(page.sql).toContain('COALESCE(severity_number, 9) >= 17')
  })

  it('reads 50 neighbors on each side by sort key and always includes the line itself', async () => {
    const target = hit(7)
    const entry = toEntry(target)
    const older = Array.from({ length: 50 }, (_, i) =>
      hit(100 + i, { _timestamp: us(now - 61_000 - i) }),
    )
    const newer = [hit(200, { _timestamp: us(now - 59_000) })]
    const context: ObsClient = {
      ...fake,
      async search(query) {
        searches.push(query)
        if (query.sql.includes(' AND (_timestamp < ')) return older
        if (query.sql.includes(' AND (_timestamp > ')) return newer
        return [target]
      },
    }
    _setObsClientForTesting(context)
    const url = `/api/ops/logs/context?id=${entry.id}`
    expect((await app.handle(new Request(`http://localhost${url}`))).status).toBe(401)
    const result = (await (await request(url)).json()) as { entries: ServerLogsResult['entries'] }
    expect(result.entries).toHaveLength(52)
    expect(result.entries[50]?.id).toBe(entry.id)
    // 按时间正序：最旧的在最前。
    expect(result.entries[0]?.at).toBeLessThan(result.entries[49]!.at)
    expect(result.entries[51]?.at).toBe(now - 59_000)
    const self = searches.find((s) => s.size === 1)!
    expect(self.sql).toContain(`md5(concat(body, '|', requestid, '|', taskid)) = '${keyOf(7)}'`)
    expect(
      searches.every((s) => s.sql.includes("COALESCE(instance, container_name) = 'bb272d8bb3c5'")),
    ).toBe(true)
    expect((await request("/api/ops/logs/context?id=bad'id")).status).toBe(400)
  })

  it('draws the span tree around the log time and rejects anything that is not a trace id', async () => {
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
    const at = now - 20 * 86_400_000
    const response = await request(`/api/ops/traces/4bf92f3577b34da6a3ce929d0e0e4736?at=${at}`)
    const trace = (await response.json()) as { tree: string; spans: number; truncated: boolean }
    expect(trace.spans).toBe(2)
    expect(trace.tree).toContain('worker task.execute')
    expect(trace.tree).toContain('  worker upstream POST')
    // 二十天前的日志：围绕它的时间查，而不是最近 7 天。
    expect(searches.at(-1)).toMatchObject({
      type: 'traces',
      startMs: at - 86_400_000,
      endMs: at + 86_400_000,
    })
    expect((await request('/api/ops/traces/not-a-trace')).status).toBe(400)
    expect((await request(`/api/ops/traces/${'0'.repeat(32)}`)).status).toBe(400)
    expect((await request('/api/ops/traces/4bf92f3577b34da6a3ce929d0e0e4736?at=x')).status).toBe(
      400,
    )
  })

  it('treats plain-text container lines and empty trace ids sensibly', () => {
    const plain = toEntry({
      _timestamp: us(now),
      body: '2026-11-20T10:00:00Z INF Registered tunnel connection connIndex=0',
      service: 'release-router',
      log_service: 'router',
      container_name: '/image-playground-paid-release-router-1',
      log_instance: '/image-playground-paid-release-router-1',
      log_key: 'f'.repeat(32),
      log_group: 'INF Registered tunnel connection connIndex=<n>',
      trace_id: '0'.repeat(32),
      span_id: '0'.repeat(16),
    })
    expect(plain).toMatchObject({
      service: 'router',
      instance: '/image-playground-paid-release-router-1',
      group_key: 'INF Registered tunnel connection connIndex=<n>',
      level: 'info',
    })
    expect(plain.fields).not.toHaveProperty('trace_id')
    expect(plain.fields).not.toHaveProperty('log_group')
  })
})

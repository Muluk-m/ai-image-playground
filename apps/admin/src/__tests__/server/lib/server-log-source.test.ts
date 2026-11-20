import { afterAll, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { ObsClient, ObsRecord } from '@image-playground/node-kit'
import { sql } from 'drizzle-orm'

process.env.DATABASE_URL = await resetTestDatabase('admin_server_log_source')
delete process.env.OBS_PROXY_URL
delete process.env.OBS_PROXY_TOKEN
const writer = createDb(process.env.DATABASE_URL)
afterAll(() => writer.close())

const {
  _setServerLogSourceForTesting,
  legacyRow,
  obsServerLogSource,
  serverLogSource,
  serverLogsCte,
} = await import('../../../../server/lib/server-log-source')
const { getTodayErrors } = await import('../../../../server/lib/today')
const { _setObsClientForTesting } = await import('../../../../server/lib/server-logs')

const now = Date.UTC(2026, 10, 20, 6)
const SCHEMA = new Set([
  '_timestamp',
  'body',
  'service',
  'instance',
  'container_name',
  'event',
  'severity_number',
  'requestid',
  'taskid',
  'errorcode',
  'err_message',
  'err_stack',
  'source',
])

const record = (extra: ObsRecord): ObsRecord => ({
  _timestamp: now * 1_000,
  body: 'API request failed',
  service: 'bff',
  log_service: 'bff',
  instance: 'bff-1',
  log_instance: 'bff-1',
  log_key: 'a'.repeat(32),
  severity_number: 17,
  source: 'stderr',
  ...extra,
})

describe('server log source for the overview errors', () => {
  it('reads nothing where the deployment has no OpenObserve', async () => {
    _setObsClientForTesting(null)
    expect(await serverLogSource()(0, now)).toEqual([])
  })

  it('restores the pino field names the classification SQL and the panel read', () => {
    const row = legacyRow(
      record({
        event: 'task.failed',
        taskid: 'task-1',
        requestid: 'req-1',
        errorcode: 'upstream_timeout',
        err_message: 'timed out',
        err_stack: 'Error: timed out\n    at run (worker.ts:1)',
      }),
    )
    expect(row).toMatchObject({
      service: 'bff',
      instance: 'bff-1',
      level: 'error',
      event: 'task.failed',
      task_id: 'task-1',
      request_id: 'req-1',
      at: new Date(now).toISOString(),
    })
    expect(row.fields).toMatchObject({
      stack: 'Error: timed out\n    at run (worker.ts:1)',
      err: { message: 'timed out', stack: 'Error: timed out\n    at run (worker.ts:1)' },
      errorCode: 'upstream_timeout',
      stream: 'stderr',
    })
  })

  it('asks for errors, tunnel lines and the causes of those requests, only by existing fields', async () => {
    const queries: string[] = []
    const client: ObsClient = {
      async search() {
        return []
      },
      async searchAll(query) {
        queries.push(query.sql)
        if (query.sql.includes('>= 17'))
          return {
            records: [
              record({ requestid: 'req-1' }),
              record({ requestid: "req-'2", log_key: 'b'.repeat(32) }),
            ],
            truncated: false,
          }
        if (query.sql.includes(" IN ('req-1', 'req-''2')"))
          return {
            records: [
              record({
                requestid: 'req-1',
                severity_number: 13,
                errorcode: 'quota_exceeded',
                log_key: 'c'.repeat(32),
              }),
            ],
            truncated: false,
          }
        return {
          records: [
            record({
              service: 'cloudflared',
              log_service: 'cloudflared',
              body: '2026-11-20T06:00:01Z INF Registered tunnel connection connIndex=0',
              severity_number: 9,
              log_key: 'd'.repeat(32),
            }),
          ],
          truncated: false,
        }
      },
      async streamFields() {
        return SCHEMA
      },
    }
    const rows = await obsServerLogSource(client)(now - 3600_000, now)
    expect(rows).toHaveLength(4)
    expect(queries).toHaveLength(3)
    expect(queries[0]).toContain('COALESCE(severity_number, 9) >= 17')
    expect(queries[1]).toContain("str_match(body, 'Registered tunnel connection')")
    expect(queries[1]).toContain("= 'cloudflared'")
    // 原因字段只引用流里有的：没有 reason、error。
    expect(queries[2]).toContain('errorcode IS NOT NULL OR err_message IS NOT NULL')
    expect(queries[2]).not.toContain('reason')
    expect(rows.find((row) => row.fields.errorCode === 'quota_exceeded')?.level).toBe('warn')
  })

  it('feeds the rows to PostgreSQL as a server_logs CTE the old SQL can read', async () => {
    const rows = [
      legacyRow(record({ errorcode: 'upstream_timeout', requestid: 'req-1' })),
      legacyRow(record({ body: "it's quoted", log_key: 'e'.repeat(32), severity_number: 9 })),
    ]
    const [result] = (await writer.db.execute(sql`
      WITH ${serverLogsCte(rows)}
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE level = 'error')::int AS errors,
        max(fields->>'errorCode') AS code,
        bool_or(fields ? 'errorCode') AS has_code,
        min(at) AS at
      FROM server_logs
    `)) as unknown as Array<Record<string, unknown>>
    expect(result).toMatchObject({ total: 2, errors: 1, code: 'upstream_timeout', has_code: true })
    expect(new Date(result!.at as string).getTime()).toBe(now)
    const [empty] = (await writer.db.execute(
      sql`WITH ${serverLogsCte([])} SELECT count(*)::int AS total FROM server_logs`,
    )) as unknown as Array<{ total: number }>
    expect(empty?.total).toBe(0)
  })

  it('keeps the overview up when OpenObserve fails, and drops NUL bytes PostgreSQL cannot store', async () => {
    const failing: ObsClient = {
      async search() {
        throw new Error('proxy down')
      },
      async searchAll() {
        throw new Error('proxy down')
      },
      async streamFields() {
        return SCHEMA
      },
    }
    _setObsClientForTesting(failing)
    expect(await serverLogSource()(0, now)).toEqual([])
    _setObsClientForTesting(null)
    const row = legacyRow(record({ body: 'bin\u0000ary', errorcode: 'x\u0000y' }))
    expect(row.message).toBe('binary')
    expect(row.fields.errorCode).toBe('xy')
    const [result] = (await writer.db.execute(
      sql`WITH ${serverLogsCte([row])} SELECT message FROM server_logs`,
    )) as unknown as Array<{ message: string }>
    expect(result?.message).toBe('binary')
  })

  it('only asks for error rows when the caller lists errors without classifying them', async () => {
    const queries: string[] = []
    const client: ObsClient = {
      async search() {
        return []
      },
      async searchAll(query) {
        queries.push(query.sql)
        return { records: [record({})], truncated: false }
      },
      async streamFields() {
        return SCHEMA
      },
    }
    expect(await obsServerLogSource(client)(0, now, { errorsOnly: true })).toHaveLength(1)
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain('>= 17')
  })

  it('classifies a cloudflared reconnect from OpenObserve rows the same way as from server_logs', async () => {
    const at = now - 10 * 60_000
    const line = (offset: number, text: string, severity: number, key: string) =>
      legacyRow(
        record({
          _timestamp: (at + offset) * 1_000,
          body: `${new Date(at + offset).toISOString()} ${text}`,
          service: 'cloudflared',
          log_service: 'cloudflared',
          instance: null,
          container_name: '/image-playground-paid-cloudflared-1',
          log_instance: '/image-playground-paid-cloudflared-1',
          severity_number: severity,
          log_key: key.repeat(32),
          source: 'stderr',
        }),
      )
    const failure = line(
      0,
      'ERR failed to serve incoming request error="Error shutting down control stream: rpc: connection closed"',
      17,
      '1',
    )
    _setServerLogSourceForTesting(async () => [
      failure,
      line(
        100,
        'WRN Serve tunnel error error="Error shutting down control stream: rpc: connection closed" connIndex=2',
        13,
        '2',
      ),
      line(1_500, 'INF Registered tunnel connection connIndex=2 location=sjc01', 9, '3'),
    ])
    try {
      const data = await getTodayErrors(now)
      const found = data.recovery?.recovered.entries.find((entry) => entry.id === failure.id)
      expect(found).toMatchObject({
        service: 'cloudflared',
        recovery: { state: 'recovered', recoveredAt: at + 1_500 },
      })
    } finally {
      _setServerLogSourceForTesting(undefined)
    }
  })
})

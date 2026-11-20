import { afterAll, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { ObsClient, ObsRecord } from '@image-playground/node-kit'
import { sql } from 'drizzle-orm'

process.env.DATABASE_URL = await resetTestDatabase('admin_server_log_source')
process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
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
const { _setObsClientForTesting } = await import('../../../../server/lib/server-logs')
const { getOverviewActivity, getTodayErrors } = await import('../../../../server/lib/today')

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

function client(answer: (statement: string) => ObsRecord[], options: { truncated?: boolean } = {}) {
  const queries: string[] = []
  const fake: ObsClient = {
    async search() {
      return []
    },
    async searchAll(query) {
      queries.push(query.sql)
      return { records: answer(query.sql), truncated: options.truncated ?? false }
    },
    async streamFields() {
      return SCHEMA
    },
  }
  return { fake, queries }
}

describe('server log source for the overview errors', () => {
  it('says the logs are off, not that there were no errors, where the deployment has no OpenObserve', async () => {
    _setObsClientForTesting(null)
    expect(await serverLogSource().logs(0, now)).toEqual({ rows: [], availability: 'off' })
  })

  it('marks OpenObserve failures as unavailable instead of failing the overview', async () => {
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
    expect(await serverLogSource().logs(0, now)).toEqual({ rows: [], availability: 'unavailable' })
    expect(await serverLogSource().causes(['r'], 0, now)).toEqual([])
    _setObsClientForTesting(null)
  })

  it('restores the pino field names the classification SQL reads, and drops NUL bytes', () => {
    const row = legacyRow(
      record({
        event: 'task.failed',
        taskid: 'task-1',
        requestid: 'req-1',
        body: 'bin\u0000ary',
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
      message: 'binary',
      at: new Date(now).toISOString(),
    })
    expect(row.fields).toMatchObject({
      stack: 'Error: timed out\n    at run (worker.ts:1)',
      err: { message: 'timed out', stack: 'Error: timed out\n    at run (worker.ts:1)' },
      errorCode: 'upstream_timeout',
      stream: 'stderr',
    })
  })

  it('reads errors and tunnel lines, reports truncation, and only errors when asked', async () => {
    const tunnel = record({
      service: 'cloudflared',
      log_service: 'cloudflared',
      body: '2026-11-20T06:00:01Z INF Registered tunnel connection connIndex=0',
      severity_number: 9,
      log_key: 'd'.repeat(32),
    })
    const { fake, queries } = client(
      (statement) => (statement.includes('>= 17') ? [record({})] : [tunnel]),
      { truncated: true },
    )
    const batch = await obsServerLogSource(fake).logs(0, now)
    expect(batch.availability).toBe('truncated')
    expect(batch.rows).toHaveLength(2)
    expect(queries[0]).toContain('COALESCE(severity_number, 9) >= 17')
    expect(queries[1]).toContain("str_match(body, 'Registered tunnel connection')")
    queries.length = 0
    const errorsOnly = await obsServerLogSource(fake).logs(0, now, { errorsOnly: true })
    expect(errorsOnly.rows).toHaveLength(1)
    expect(queries).toHaveLength(1)
  })

  it('looks up causes for the given requests only, by fields the stream has', async () => {
    const { fake, queries } = client(() => [
      record({ requestid: 'req-1', severity_number: 13, errorcode: 'quota_exceeded' }),
    ])
    const rows = await obsServerLogSource(fake).causes(['req-1', "req-'2"], 0, now)
    expect(rows[0]?.fields.errorCode).toBe('quota_exceeded')
    expect(queries[0]).toContain("requestid IN ('req-1', 'req-''2')")
    expect(queries[0]).toContain('errorcode IS NOT NULL OR err_message IS NOT NULL')
    expect(queries[0]).not.toContain('reason')
    expect(await obsServerLogSource(fake).causes([], 0, now)).toEqual([])
  })

  it('feeds rows to PostgreSQL as a server_logs CTE the old SQL can read', async () => {
    const rows = [
      legacyRow(record({ errorcode: 'upstream_timeout', requestid: 'req-1' })),
      legacyRow(record({ body: "it's quoted", log_key: 'e'.repeat(32), severity_number: 9 })),
    ]
    const [result] = (await writer.db.execute(sql`
      WITH ${serverLogsCte(rows)}
      SELECT count(*)::int AS total, count(*) FILTER (WHERE level = 'error')::int AS errors,
        max(fields->>'errorCode') AS code, bool_or(fields ? 'errorCode') AS has_code, min(at) AS at
      FROM server_logs
    `)) as unknown as Array<Record<string, unknown>>
    expect(result).toMatchObject({ total: 2, errors: 1, code: 'upstream_timeout', has_code: true })
    expect(new Date(result!.at as string).getTime()).toBe(now)
    const [empty] = (await writer.db.execute(
      sql`WITH ${serverLogsCte([])} SELECT count(*)::int AS total FROM server_logs`,
    )) as unknown as Array<{ total: number }>
    expect(empty?.total).toBe(0)
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
        }),
      )
    const failure = line(
      0,
      'ERR failed to serve incoming request error="Error shutting down control stream: rpc: connection closed"',
      17,
      '1',
    )
    _setServerLogSourceForTesting({
      async logs() {
        return {
          rows: [
            failure,
            line(
              100,
              'WRN Serve tunnel error error="Error shutting down control stream: rpc: connection closed" connIndex=2',
              13,
              '2',
            ),
            line(1_500, 'INF Registered tunnel connection connIndex=2 location=sjc01', 9, '3'),
          ],
          availability: 'complete',
        }
      },
      async causes() {
        return []
      },
    })
    try {
      const data = await getTodayErrors(now)
      expect(data.serverLogs).toBe('complete')
      expect(
        data.recovery?.recovered.entries.find((entry) => entry.id === failure.id),
      ).toMatchObject({
        service: 'cloudflared',
        recovery: { state: 'recovered', recoveredAt: at + 1_500 },
      })
    } finally {
      _setServerLogSourceForTesting(undefined)
    }
  })

  it('looks up causes for every error the panel shows, however old, and reports availability', async () => {
    const errors = Array.from({ length: 302 }, (_, index) =>
      legacyRow(
        record({
          _timestamp: (now - index * 1_000) * 1_000,
          requestid: `req-${index}`,
          log_key: index.toString(16).padStart(32, '0'),
        }),
      ),
    )
    const asked: string[][] = []
    _setServerLogSourceForTesting({
      async logs() {
        return { rows: errors, availability: 'truncated' }
      },
      async causes(requestIds) {
        asked.push([...requestIds])
        return []
      },
    })
    try {
      const data = await getTodayErrors(now)
      expect(data.serverLogs).toBe('truncated')
      expect(asked).toHaveLength(1)
      // 补查的正是面板上展示的那些错误所在的请求。
      const shown = [
        ...data.entries,
        ...(data.recovery?.unknown.entries ?? []),
        ...(data.recovery?.unresolved.entries ?? []),
      ]
        .map((entry) => entry.request_id)
        .filter((id): id is string => id !== null)
      expect(shown.length).toBeGreaterThan(0)
      for (const id of shown) expect(asked[0]).toContain(id)
      const activity = await getOverviewActivity({ from: now - 3600_000, to: now })
      expect(activity.server.availability).toBe('truncated')
    } finally {
      _setServerLogSourceForTesting(undefined)
    }
  })
})

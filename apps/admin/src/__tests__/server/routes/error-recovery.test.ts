import { afterAll, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import { sql } from 'drizzle-orm'

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = await resetTestDatabase('admin_error_recovery')
const writer = createDb(process.env.DATABASE_URL)
const { getTodayErrors } = await import('../../../../server/lib/today')
afterAll(() => writer.close())
const now = Date.UTC(2026, 9, 15, 6)
const failure =
  'ERR failed to serve incoming request error="Error shutting down control stream: rpc: connection closed"'
const warning =
  'WRN Serve tunnel error error="Error shutting down control stream: rpc: connection closed"'
const edgeFailure =
  'ERR failed to serve incoming request error="Error shutting down control stream: client disconnected"'
const edgeWarning = 'WRN Serve tunnel error error="connection with edge closed"'
function log(
  id: string,
  at: number,
  message: string,
  instance = 'tunnel-1',
  level: 'info' | 'warn' | 'error' = 'info',
) {
  return {
    id,
    at,
    message: `${new Date(at).toISOString()} ${message}`,
    instance,
    level,
    service: 'cloudflared' as const,
    version: '',
    group_key: 'tunnel',
    fields: {},
  }
}

async function disconnect(id: string, index: number, at: number, instance = id) {
  await writer.db
    .insert(writer.schema.server_logs)
    .values([
      log(id, at, failure, instance, 'error'),
      log(`${id}-warning`, at + 100, `${warning} connIndex=${index}`, instance, 'warn'),
    ])
}

function all(data: Awaited<ReturnType<typeof getTodayErrors>>) {
  return Object.values(data.recovery!).flatMap((group) => group.entries)
}

describe('evidence-backed error recovery', () => {
  it('matches only the same tunnel instance and connection, including the index-less production error', async () => {
    const at = now - 60_000
    await disconnect('restored', 2, at)
    await disconnect('wrong-index', 0, at)
    await disconnect('wrong-instance', 1, at)
    await disconnect('before-error', 0, at)
    await disconnect('future', 0, at)
    await disconnect('ambiguous', 0, at)
    await writer.db
      .insert(writer.schema.server_logs)
      .values([
        log('restored-ok', at + 7000, 'INF Registered tunnel connection connIndex=2', 'restored'),
        log(
          'wrong-index-ok',
          at + 7000,
          'INF Registered tunnel connection connIndex=1',
          'wrong-index',
        ),
        log(
          'wrong-instance-ok',
          at + 7000,
          'INF Registered tunnel connection connIndex=1',
          'other',
        ),
        log(
          'before-error-ok',
          at - 1,
          'INF Registered tunnel connection connIndex=0',
          'before-error',
        ),
        log('future-ok', now + 1, 'INF Registered tunnel connection connIndex=0', 'future'),
        log('ambiguous-warning-2', at + 200, `${warning} connIndex=1`, 'ambiguous', 'warn'),
        log('ambiguous-ok', at + 7000, 'INF Registered tunnel connection connIndex=0', 'ambiguous'),
        log('unrelated-error', at, 'ERR origin connection refused', 'restored', 'error'),
      ])
    const data = await getTodayErrors(now)
    expect(data.recovery?.recovered.total).toBe(1)
    expect(data.recovery?.recovered.entries[0]).toMatchObject({
      id: 'restored',
      recovery: {
        state: 'recovered',
        recoveredAt: at + 7000,
      },
    })
    expect(data.recovery?.unknown.total).toBe(6)
    expect(data.recovery?.unresolved.total).toBe(0)
    expect(
      all(data)
        .filter((entry) => entry.id !== 'restored')
        .every((entry) => entry.recovery?.state === 'unknown'),
    ).toBe(true)
    // A subsequent failure remains a separate unknown event, even though the earlier one recovered.
    await disconnect('restored-again', 2, now - 1000, 'restored')
    const repeated = await getTodayErrors(now)
    expect(repeated.recovery?.recovered.total).toBe(1)
    expect(
      repeated.recovery?.unknown.entries.find((entry) => entry.id === 'restored-again'),
    ).toBeDefined()
  })

  it('recovers both production edge-disconnect variants using loss, warning and registration evidence', async () => {
    const cases = [
      {
        id: 'edge-internal',
        at: Date.parse('2026-10-15T06:11:23.245Z'),
        recoveredAt: Date.parse('2026-10-15T06:11:24.832Z'),
        index: 0,
      },
      {
        id: 'edge-paid',
        at: Date.parse('2026-10-15T08:54:16.146Z'),
        recoveredAt: Date.parse('2026-10-15T08:54:23.971Z'),
        index: 1,
      },
    ]
    for (const entry of cases) {
      await writer.db
        .insert(writer.schema.server_logs)
        .values([
          log(entry.id, entry.at, edgeFailure, entry.id, 'error'),
          log(
            `${entry.id}-lost`,
            entry.at,
            `INF Lost connection with the edge connIndex=${entry.index}`,
            entry.id,
          ),
          log(
            `${entry.id}-warning`,
            entry.at,
            `${edgeWarning} connIndex=${entry.index}`,
            entry.id,
            'warn',
          ),
          log(
            `${entry.id}-ok`,
            entry.recoveredAt,
            `INF Registered tunnel connection connIndex=${entry.index}`,
            entry.id,
          ),
        ])
    }
    const data = await getTodayErrors(Date.parse('2026-10-15T08:55:00Z'))
    for (const entry of cases) {
      expect(data.recovery?.recovered.entries.find((item) => item.id === entry.id)).toMatchObject({
        recovery: { state: 'recovered', recoveredAt: entry.recoveredAt },
      })
    }
  })

  it('leaves edge disconnects unconfirmed when loss or recovery evidence is missing, mismatched or ambiguous', async () => {
    const snapshot = now + 7 * 86400_000
    const at = snapshot - 60_000
    const cases = [
      'missing-loss',
      'wrong-loss-index',
      'wrong-loss-instance',
      'unrelated-warning',
      'missing-recovery',
      'wrong-recovery-index',
      'wrong-recovery-instance',
      'ambiguous-edge',
      'ambiguous-partial-loss',
      'recovery-before-loss',
      'future-recovery',
      'earlier-recovery',
    ]
    for (const id of cases) {
      const rows = [
        log(id, at, edgeFailure, id, 'error'),
        log(
          `${id}-warning`,
          at,
          `${id === 'unrelated-warning' ? warning : edgeWarning} connIndex=0`,
          id,
          'warn',
        ),
      ]
      if (id !== 'missing-loss')
        rows.push(
          log(
            `${id}-lost`,
            id === 'recovery-before-loss' ? at + 1000 : at,
            `INF Lost connection with the edge connIndex=${id === 'wrong-loss-index' ? 1 : 0}`,
            id === 'wrong-loss-instance' ? 'other-tunnel' : id,
          ),
        )
      if (id !== 'missing-recovery')
        rows.push(
          log(
            `${id}-ok`,
            id === 'recovery-before-loss'
              ? at + 500
              : id === 'future-recovery'
                ? snapshot + 1
                : id === 'earlier-recovery'
                  ? at - 1
                  : at + 8000,
            `INF Registered tunnel connection connIndex=${id === 'wrong-recovery-index' ? 1 : 0}`,
            id === 'wrong-recovery-instance' ? 'other-tunnel' : id,
          ),
        )
      if (id === 'ambiguous-partial-loss')
        rows.push(log(`${id}-warning-2`, at, `${edgeWarning} connIndex=1`, id, 'warn'))
      if (id === 'ambiguous-edge')
        rows.push(
          log(`${id}-lost-2`, at, 'INF Lost connection with the edge connIndex=1', id),
          log(`${id}-warning-2`, at, `${edgeWarning} connIndex=1`, id, 'warn'),
        )
      await writer.db.insert(writer.schema.server_logs).values(rows)
    }
    const data = await getTodayErrors(snapshot)
    expect(data.recovery?.recovered.total).toBe(0)
    expect(data.recovery?.unknown.total).toBe(cases.length)
    expect(data.recovery?.unknown.entries).toHaveLength(10)
  })

  it('counts all records and retains each status beyond the latest ten, without treating quiet client errors as recovered', async () => {
    const later = now + 86400_000
    const at = later - 3600_000
    await writer.db.insert(writer.schema.tasks).values([
      {
        id: 'recovered-task',
        provider: 'openai-compat',
        model: 'test',
        status: 'completed',
        request_payload: { prompt: 'test', device_id: 'recovery-test' },
        submitted_at: at - 1000,
        completed_at: at + 1000,
      },
      {
        id: 'failed-task',
        provider: 'openai-compat',
        model: 'test',
        status: 'failed',
        request_payload: { prompt: 'test', device_id: 'recovery-test' },
        submitted_at: at - 1000,
        completed_at: at,
      },
    ])
    await writer.db.insert(writer.schema.server_logs).values([
      {
        ...log('task-recovered', at, 'ERR task failed', 'worker', 'error'),
        service: 'worker',
        event: 'task.failed',
        task_id: 'recovered-task',
      },
      {
        ...log('task-failed', at, 'ERR task failed', 'worker', 'error'),
        service: 'worker',
        event: 'task.failed',
        task_id: 'failed-task',
      },
    ])
    await writer.db.insert(writer.schema.client_errors).values({
      id: 'quiet-client',
      fingerprint: 'client-1',
      kind: 'boot',
      message: 'timeout',
      received_at: at,
    })
    for (let i = 0; i < 12; i++) {
      await disconnect(`many-${i}`, 0, later - 20_000 + i, `many-${i}`)
      await writer.db
        .insert(writer.schema.server_logs)
        .values(
          log(
            `many-ok-${i}`,
            later - 1000,
            'INF Registered tunnel connection connIndex=0',
            `many-${i}`,
          ),
        )
    }
    const data = await getTodayErrors(later)
    expect(data.total).toBe(15)
    expect(data.entries).toHaveLength(10)
    expect(data.recovery?.recovered.total).toBe(13)
    expect(data.recovery?.recovered.entries).toHaveLength(10)
    expect(data.recovery?.unresolved.entries[0]?.id).toBe('task-failed')
    expect(data.recovery?.unknown.entries[0]?.id).toBe('quiet-client')
    expect(data.recent?.total).toBe(12)
    expect(data.recent?.recovery?.recovered.total).toBe(12)
    expect(data.recent?.recovery?.unknown.total).toBe(0)
    expect(data.recent?.recovery?.unresolved.entries).toEqual([])
    const beforeMany = await getTodayErrors(at + 2000)
    expect(beforeMany.recovery?.recovered.entries[0]).toMatchObject({
      id: 'task-recovered',
      recovery: { recoveredAt: at + 1000 },
    })
  })

  it('keeps repeated failures unknown amid a large window of unrelated tunnel logs', async () => {
    const end = now + 5 * 86400_000
    const start = end - 6 * 3600_000
    await writer.db.execute(sql`
      INSERT INTO server_logs (id, at, service, instance, level, version, message, fields, group_key)
      SELECT 'load-failure-' || i, ${new Date(start)}::timestamptz + i * interval '10 seconds',
        'cloudflared', 'load-tunnel', 'error', '', ${`2026-10-20T00:00:00Z ${edgeFailure}`}, '{}'::jsonb, 'load'
      FROM generate_series(1, 1000) i
      UNION ALL
      SELECT 'load-warning-' || i, ${new Date(start)}::timestamptz + i * interval '10 seconds' + interval '100 milliseconds',
        'cloudflared', 'load-tunnel', 'warn', '', ${`2026-10-20T00:00:00Z ${edgeWarning} connIndex=0`}, '{}'::jsonb, 'load'
      FROM generate_series(1, 1000) i
      UNION ALL
      SELECT 'load-loss-' || i, ${new Date(start)}::timestamptz + i * interval '10 seconds',
        'cloudflared', 'load-tunnel', 'info', '', '2026-10-20T00:00:00Z INF Lost connection with the edge connIndex=0', '{}'::jsonb, 'load'
      FROM generate_series(1, 1000) i
      UNION ALL
      SELECT 'load-noise-' || i, ${new Date(start)}::timestamptz + i * interval '200 milliseconds',
        'cloudflared', 'load-tunnel', 'info', '', 'INF unrelated tunnel message', '{}'::jsonb, 'load'
      FROM generate_series(1, 50000) i
    `)
    const data = await getTodayErrors(end)
    expect(data.total).toBe(1000)
    expect(data.recovery?.unknown.total).toBe(1000)
    expect(data.recovery?.unknown.entries).toHaveLength(10)
    expect(data.recovery?.recovered.total).toBe(0)
  })

  it('can recover an error across midnight while counting it only in the recent window', async () => {
    const midnight = Date.UTC(2026, 9, 17, 16)
    await disconnect('midnight', 3, midnight - 5000)
    await writer.db
      .insert(writer.schema.server_logs)
      .values(
        log(
          'midnight-ok',
          midnight + 1000,
          'INF Registered tunnel connection connIndex=3',
          'midnight',
        ),
      )
    const data = await getTodayErrors(midnight + 5000)
    expect(data.total).toBe(0)
    expect(data.recovery?.recovered.total).toBe(0)
    expect(data.recent?.recovery?.recovered.total).toBe(1)
    expect(data.recent?.recovery?.recovered.entries[0]?.recovery?.recoveredAt).toBe(midnight + 1000)
  })
})

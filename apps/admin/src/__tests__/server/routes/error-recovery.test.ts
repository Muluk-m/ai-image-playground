import { afterAll, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'

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

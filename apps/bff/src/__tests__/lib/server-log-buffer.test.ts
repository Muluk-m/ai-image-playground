import { describe, expect, it } from 'bun:test'
import { createServerLogBuffer, parseServerLog } from '../../lib/server-log-buffer'

const identity = { service: 'worker' as const, instance: 'instance-1', version: 'release-1' }
const entry = (message = 'done') =>
  parseServerLog(
    JSON.stringify({ level: 30, time: '2026-10-07T00:00:00Z', msg: message }),
    identity,
  )!

describe('structured server log collection', () => {
  it('retains identity, error stacks and correlation while removing secrets and raw content', () => {
    const row = parseServerLog(
      JSON.stringify({
        level: 50,
        time: '2026-10-07T00:00:00Z',
        event: 'task.failed',
        taskId: 'task-42',
        requestId: 'req-42',
        msg: 'failed: Bearer private-credential https://user:pass@upstream.test/?token=secret-value',
        err: {
          message: 'api_key=secret-value',
          stack: 'Error at worker.ts:42',
          nested: { apiKey: 'top-secret' },
        },
        request_payload: { prompt: 'private prompt' },
        headers: { authorization: 'private-credential' },
      }),
      identity,
    )!
    expect(row).toMatchObject({
      ...identity,
      level: 'error',
      event: 'task.failed',
      group_key: 'task.failed',
      task_id: 'task-42',
      request_id: 'req-42',
    })
    const stored = JSON.stringify(row)
    for (const secret of [
      'private-credential',
      'secret-value',
      'top-secret',
      'private prompt',
      'user:pass',
    ])
      expect(stored).not.toContain(secret)
    expect(stored).toContain('Error at worker.ts:42')
  })

  it('groups unstructured messages without per-request numbers, rejects invalid lines and caps size', () => {
    expect(entry('failed after 123 ms').group_key).toBe(entry('failed after 456 ms').group_key)
    expect(entry('x'.repeat(10000)).message.length).toBe(4000)
    expect(parseServerLog('not-json', identity)).toBeNull()
    expect(parseServerLog('{"level":50,"time":"bad"}', identity)).toBeNull()
    const oversized = parseServerLog(
      JSON.stringify({
        level: 30,
        time: Date.now(),
        diagnostics: Array.from({ length: 20 }, () => 'x'.repeat(4000)),
      }),
      identity,
    )!
    expect(oversized.fields).toEqual({ truncated: true, event: null })
    expect(
      entry('upstream returned {"apiKey":"secret-value"} and data:image/png;base64,AAAA').message,
    ).not.toContain('secret-value')
    expect(entry('data:image/png;base64,AAAA').message).toBe('[BINARY REDACTED]')
  })

  it('retries the same batch after failure, deduplicates concurrent flushes and bounds memory', async () => {
    const saved: string[] = []
    let fail = true
    let calls = 0
    const buffer = createServerLogBuffer({
      maxEntries: 2,
      batchSize: 1,
      onFailure: () => {},
      write: async (rows) => {
        calls++
        if (fail) throw new Error('database unavailable')
        saved.push(...rows.map((row) => row.id))
      },
    })
    const first = entry('first'),
      second = entry('second')
    buffer.enqueue(first)
    buffer.enqueue(second)
    buffer.enqueue(entry('overflow'))
    await Promise.all([buffer.flush(), buffer.flush()])
    expect(calls).toBe(1)
    expect(buffer.stats()).toMatchObject({ pending: 2, dropped: 1, failures: 1 })
    fail = false
    await buffer.drain()
    expect(saved).toEqual([first.id, second.id])
    expect(buffer.stats().pending).toBe(0)
  })
})

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
  it('removes raw response previews, serialized user content and NUL in every persisted string', () => {
    const row = parseServerLog(
      JSON.stringify({
        level: 50,
        time: Date.now(),
        msg: 'upstream error: {"prompt":"user original", "content":"private text", "code":"failed"}',
        payloadPreview: '{"prompt":"preview original"}',
        err: { message: '{"content":"private message", "reason":"bad request"}' },
        'diag\u0000key': 'valid\u0000value',
      }),
      identity,
    )!
    const stored = JSON.stringify(row)
    for (const privateText of [
      'user original',
      'private text',
      'preview original',
      'private message',
      '\\u0000',
    ])
      expect(stored).not.toContain(privateText)
    expect(row.fields.diagkey).toBe('validvalue')
    expect(stored).toContain('bad request')
  })

  it('pumps several healthy batches in one cycle instead of waiting between batches', async () => {
    const saved: string[] = []
    const buffer = createServerLogBuffer({
      maxEntries: 200,
      batchSize: 10,
      onFailure: () => {},
      write: async (rows) => {
        saved.push(...rows.map((row) => row.id))
      },
    })
    for (let index = 0; index < 150; index++) buffer.enqueue(entry(String(index)))
    await buffer.pump()
    expect(saved).toHaveLength(150)
    expect(buffer.stats()).toMatchObject({ pending: 0, dropped: 0 })
  })

  it('returns at the drain deadline and does not start another batch after timeout', async () => {
    let release: () => void = () => {}
    let calls = 0
    const buffer = createServerLogBuffer({
      batchSize: 1,
      onFailure: () => {},
      write: async () => {
        calls++
        await new Promise<void>((resolve) => {
          release = resolve
        })
      },
    })
    buffer.enqueue(entry('first'))
    buffer.enqueue(entry('second'))
    await buffer.drain(10)
    expect(buffer.stats().pending).toBe(2)
    expect(calls).toBe(1)
    release()
    await buffer.flush()
    expect(calls).toBe(1)
    expect(buffer.stats().pending).toBe(1)
  })
  it('scrubs independent and malformed JSON fragments and checks long keys before truncating', () => {
    const multiple = entry(
      'upstream {"responseBody":"private original", "headers":{"cookie":"session=private"}} {"code":"failed"}',
    )
    expect(multiple.message).not.toContain('private original')
    expect(multiple.message).not.toContain('session=private')
    expect(multiple.message).toContain('failed')
    const broken = entry(
      'upstream {"ResponseBody":"private original", "HEADERS":{"Cookie":"private session"}',
    )
    expect(broken.message).not.toContain('private original')
    expect(broken.message).not.toContain('private session')
    const longKey = 'x'.repeat(200) + 'token'
    const row = parseServerLog(
      JSON.stringify({
        level: 30,
        time: Date.now(),
        msg: 'error',
        [longKey]: 'unprefixed-secret-value',
      }),
      identity,
    )!
    expect(JSON.stringify(row)).not.toContain('unprefixed-secret-value')
    expect(row.fields['x'.repeat(200)]).toBe('[REDACTED]')
    // Braces inside quoted JSON strings must not split fragments.
    const quoted = entry(
      'upstream {"prompt":"private } original", "reason":"brace { inside"} {"code":"failed"}',
    )
    expect(quoted.message).not.toContain('private } original')
    expect(quoted.message).toContain('failed')
  })

  it('bounds malformed text scanning before processing large input', () => {
    expect(entry('{'.repeat(10_000)).message).toBe('[REDACTED PAYLOAD]')
    expect(entry('{'.repeat(100_000)).message).toBe('[TRUNCATED LOG TEXT]')
  })
})

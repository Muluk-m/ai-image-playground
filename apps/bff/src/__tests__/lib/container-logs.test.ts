import { describe, expect, it } from 'bun:test'
import { containerService, parseContainerLog } from '../../lib/container-logs'

const record = (log: string, container = '/image-playground-paid-admin-1', source = 'stdout') => ({
  date: 1791428529.709582,
  container_name: container,
  source,
  log,
})

describe('container log records', () => {
  it('names the service from release-managed and Compose container names', () => {
    expect(containerService('/image-playground-paid-r20261007153518-2827408-bff')).toBe('bff')
    expect(containerService('image-playground-test-r20261001161646-1919398-worker')).toBe('worker')
    expect(containerService('image-playground-paid-r20261007153518-2827408-migrate')).toBe(
      'migrate',
    )
    expect(containerService('image-playground-paid-release-router')).toBe('router')
    expect(containerService('image-playground-paid-release-router-retiring')).toBe('router')
    expect(containerService('image-playground-internal-host-collector-1')).toBe('host-collector')
    expect(containerService('image-playground-paid-pg-backup-1')).toBe('pg-backup')
    expect(containerService('image-playground-paid-cloudflared-1')).toBe('cloudflared')
    expect(containerService('image-playground-paid-dependency-check-1')).toBe('migrate')
    expect(containerService('image-playground-paid-bff-1')).toBe('bff')
    expect(containerService('/funny_tesla')).toBe('other')
  })

  it('keeps the structure of JSON lines and takes their version', () => {
    const entry = parseContainerLog(
      record(
        JSON.stringify({
          level: 50,
          time: 1791428529000,
          msg: 'task failed',
          event: 'task.failed',
          taskId: 't-1',
          version: 'abc123',
          apiKey: 'sk-secretvalue12345',
        }),
        '/image-playground-paid-r20261007153518-2827408-worker',
      ),
    )!
    expect(entry).toMatchObject({
      service: 'worker',
      instance: 'image-playground-paid-r20261007153518-2827408-worker',
      version: 'abc123',
      level: 'error',
      event: 'task.failed',
      task_id: 't-1',
      at: 1791428529710,
    })
    expect(entry.fields).toMatchObject({ apiKey: '[REDACTED]', stream: 'stdout' })
  })

  it('reads the level of plain text lines from their words, then from the stream', () => {
    const level = (line: string, source = 'stdout') =>
      parseContainerLog(record(line, '/image-playground-paid-cloudflared-1', source))!.level
    expect(level('2026-10-08T03:01:40Z ERR Failed to serve tunnel connection')).toBe('error')
    expect(level('2026-10-08T03:01:40Z WRN Connection terminated', 'stderr')).toBe('warn')
    expect(level('2026-10-08T03:01:40Z INF Registered tunnel connection', 'stderr')).toBe('info')
    expect(level('[ops] snapshot built in 41ms')).toBe('info')
    expect(level('something odd happened', 'stderr')).toBe('warn')
    expect(level('    at callProvider (queue/run.ts:214)', 'stderr')).toBe('error')
  })

  it('timestamps text lines from the driver, groups them without numbers and redacts secrets', () => {
    const entry = parseContainerLog(
      record('2026-10-08T03:01:40Z INF retry 3 with Bearer abc.def.ghi took 41ms'),
    )!
    expect(entry.at).toBe(1791428529710)
    expect(entry.message).toContain('Bearer [REDACTED]')
    expect(entry.group_key).toBe('INF retry <n> with Bearer [REDACTED] took <n>ms')
    expect(entry.fields).toEqual({ stream: 'stdout' })
  })

  it('deduplicates retries while keeping successive identical lines distinct', () => {
    const input = record('same log')
    expect(parseContainerLog(input)!.id).toBe(parseContainerLog(input)!.id)
    expect(parseContainerLog({ ...input, date: input.date + 0.001 })!.id).not.toBe(
      parseContainerLog(input)!.id,
    )
  })

  it('drops records without a line or container', () => {
    expect(parseContainerLog(record('   '))).toBeNull()
    expect(parseContainerLog({ log: 'x' })).toBeNull()
    expect(parseContainerLog(null)).toBeNull()
    expect(parseContainerLog(42)).toBeNull()
    expect(parseContainerLog({ ...record('x'), date: 1e20 })).toBeNull()
  })
  it('cleans version strings and connection URI credentials before storage', () => {
    const input = record(
      JSON.stringify({
        level: 30,
        time: Date.now(),
        version: 'v\u0000x',
        msg: 'failed: postgresql://app:plain-password@db/app',
      }),
    )
    const entry = parseContainerLog(input)!
    expect(entry.version).toBe('vx')
    expect(JSON.stringify(entry)).not.toContain('plain-password')
    const text = parseContainerLog(record('failed: redis://user:plain-password@db/0'))!
    expect(text.message).not.toContain('plain-password')
  })
})

import { afterAll, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AlertMessage } from '@image-playground/shared'

const databaseUrl = await resetTestDatabase('bff_app_alerts')
process.env.DATABASE_URL = databaseUrl

const writer = createDb(databaseUrl)
const { createAppAlerting, observeApp } = await import('../../ops/app-alerts')
const { close } = await import('../../db/client')

afterAll(async () => {
  await Promise.all([writer.close(), close()])
})

const minute = 60_000
const hour = 60 * minute
const now = Date.now()

await writer.db.insert(writer.schema.users).values({
  id: 'full-alert-account',
  username: 'full-alert-account',
  password_hash: 'test',
  created_at: now,
  updated_at: now,
})

await writer.db.insert(writer.schema.tasks).values([
  {
    id: 'waiting-long',
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'queued',
    request_payload: { prompt: 'x', device_id: 'd' },
    submitted_at: now - 12 * minute,
  },
  {
    id: 'chat-turn-waiting-longer',
    kind: 'chat',
    provider: 'openai-compat',
    model: 'gpt-5',
    status: 'queued',
    request_payload: { prompt: 'x', device_id: 'd' },
    submitted_at: now - 50 * minute,
  },
  {
    id: 'generated-result-awaiting-save',
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'queued',
    request_payload: { prompt: 'x', device_id: 'd' },
    archive_payload: { outputs: [] },
    submitted_at: now - 50 * minute,
  },
  {
    id: 'retry-not-due',
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'queued',
    request_payload: { prompt: 'x', device_id: 'd' },
    next_retry_at: now + minute,
    submitted_at: now - 50 * minute,
  },
  {
    id: 'retry-just-due',
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'queued',
    request_payload: { prompt: 'x', device_id: 'd' },
    next_retry_at: now - minute,
    submitted_at: now - 50 * minute,
  },
  ...Array.from({ length: 3 }, (_, index) => ({
    id: `full-alert-running-${index}`,
    user_id: 'full-alert-account',
    provider: 'openai-compat' as const,
    model: 'gpt-image-2',
    status: 'in_progress' as const,
    request_payload: { prompt: 'x', device_id: 'd' },
    submitted_at: now - 55 * minute,
  })),
  {
    id: 'full-alert-queued',
    user_id: 'full-alert-account',
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'queued',
    request_payload: { prompt: 'x', device_id: 'd' },
    submitted_at: now - 50 * minute,
  },
])
await writer.db.insert(writer.schema.service_heartbeats).values([
  { service: 'bff', instance: 'old', version: 'a', last_seen_at: now - 3 * hour },
  { service: 'bff', instance: 'current', version: 'b', last_seen_at: now - 5 * minute },
  { service: 'worker', instance: 'me', version: 'b', last_seen_at: now - 1_000 },
])

describe('observeApp', () => {
  it('reads the four application blocks the worker can see', async () => {
    const observation = await observeApp({
      now,
      readBackups: async () => ({
        latest: { key: 'pg/x.dump', size_bytes: 1, modified_at: now - 30 * hour },
        previous: null,
      }),
      readRestoreDrill: async () => ({
        ok: false,
        finished_at: now - 2 * hour,
        error: 'pg_restore: bad input',
      }),
    })

    // 对话轮、保存重试、未到期重试和账号限流不占实际排队；已到期重试从到期时算。
    expect(observation.queue?.oldest_queued_wait_ms).toBeGreaterThanOrEqual(12 * minute)
    expect(observation.queue?.oldest_queued_wait_ms).toBeLessThan(13 * minute)
    expect(observation.backup).toEqual({ latest_modified_at: now - 30 * hour })
    expect(observation.restoreDrill).toEqual({
      ok: false,
      finished_at: now - 2 * hour,
      error: 'pg_restore: bad input',
    })
    // 只看后端最新的那个实例；worker 不判断自己的心跳，发告警的就是它。
    expect(observation.heartbeats).toEqual({ bff: now - 5 * minute })
    expect(observation.host).toBeUndefined()
  })

  it('leaves out a block it could not read, so that rule is skipped this round', async () => {
    const observation = await observeApp({
      now,
      readBackups: async () => {
        throw new Error('object store unreachable')
      },
      readRestoreDrill: async () => {
        throw new Error('object store unreachable')
      },
    })
    expect(observation.backup).toBeUndefined()
    expect(observation.restoreDrill).toBeUndefined()
    expect(observation.queue).toBeDefined()
    expect(observation.heartbeats).toBeDefined()
  })

  it('passes on a drill that never ran as null, so the rule stays quiet', async () => {
    const observation = await observeApp({
      now,
      readBackups: async () => ({ latest: null, previous: null }),
      readRestoreDrill: async () => null,
    })
    expect(observation.restoreDrill).toBeNull()
  })
})

describe('createAppAlerting', () => {
  it('fires the four rules once, then stays quiet, then reports the recovery', async () => {
    const sent: AlertMessage[] = []
    let backupAt = now - 30 * hour
    let drillOk = false
    const check = createAppAlerting({
      send: async (messages) => {
        sent.push(...messages)
      },
      readBackups: async () => ({
        latest: { key: 'pg/x.dump', size_bytes: 1, modified_at: backupAt },
        previous: null,
      }),
      readRestoreDrill: async () => ({
        ok: drillOk,
        finished_at: now - hour,
        error: drillOk ? null : 'x',
      }),
    })

    await check(now)
    expect(sent.map((message) => `${message.kind}:${message.rule}`).sort()).toEqual([
      'firing:backup',
      'firing:heartbeat:bff',
      'firing:queue',
      'firing:restore',
    ])

    sent.length = 0
    await check(now + 5 * minute)
    expect(sent).toEqual([])

    backupAt = now + 5 * minute
    drillOk = true
    await check(now + 10 * minute)
    expect(sent.map((message) => `${message.kind}:${message.rule}`).sort()).toEqual([
      'resolved:backup',
      'resolved:restore',
    ])
  })

  it('never lets a failed send escape into the maintenance loop, and retries next round', async () => {
    let attempts = 0
    const check = createAppAlerting({
      send: async () => {
        attempts++
        throw new Error('webhook down')
      },
      readBackups: async () => ({ latest: null, previous: null }),
      readRestoreDrill: async () => null,
    })
    await check(now)
    await check(now + 5 * minute)
    expect(attempts).toBe(2)
  })
})

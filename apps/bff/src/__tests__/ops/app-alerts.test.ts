import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import { type AlertMessage, OPS_THRESHOLDS } from '@image-playground/shared'
import { eq, inArray } from 'drizzle-orm'
import { OpsStorageError } from '../../lib/ops-storage-error'

const databaseUrl = await resetTestDatabase('bff_app_alerts')
process.env.DATABASE_URL = databaseUrl

const writer = createDb(databaseUrl)
const { createAppAlerting, latestObsLogReader, observeApp, upstreamStatsReader } = await import(
  '../../ops/app-alerts'
)
const { log } = await import('../../lib/logger')
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
await writer.db.insert(writer.schema.tasks).values([
  {
    id: 'system-failure',
    user_id: 'full-alert-account',
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'failed',
    error_type: 'upstream_error',
    upstream_status: 502,
    // 第二个密钥横跨第 400 字：先截断再脱敏会漏出半截 `sk-abc`。
    error_message: `Bad gateway from key sk-live-abcdef123456 data:image/png;base64,${'A'.repeat(329)} sk-abcdefghijklmnopqrstuvwxyz0123 tail`,
    request_payload: { prompt: 'x' },
    submitted_at: now - minute,
    completed_at: now - minute,
  },
  {
    id: 'earlier-success',
    user_id: 'full-alert-account',
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'completed',
    request_payload: { prompt: 'x' },
    submitted_at: now - 2 * hour,
    completed_at: now - 2 * hour,
  },
  {
    id: 'policy-rejection',
    user_id: 'full-alert-account',
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'failed',
    error_type: 'content_policy',
    request_payload: { prompt: 'x' },
    submitted_at: now - minute,
    completed_at: now - minute,
  },
])
await writer.db.insert(writer.schema.api_minutes).values({
  minute: Math.floor((now - minute) / minute) * minute,
  instance: 'bff-alert-test',
  requests: 20,
  client_errors: 0,
  server_errors: 0,
})
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
      watchingModels: ['gpt-image-2'],
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
    expect(observation.api).toEqual({
      requests: 20,
      server_errors: 0,
      errors_by_minute: {},
      successes_by_minute: { [Math.floor((now - minute) / minute) * minute]: 20 },
      error_routes: {},
    })
    expect(observation.failures).toEqual({
      generation_system: 1,
      agent: 0,
      generation_models: [
        {
          model: 'gpt-image-2',
          failures: 1,
          errorType: 'upstream_error',
          upstreamStatus: 502,
          // 整段原文先抹掉令牌、密钥和二进制，再截 200 字。
          message: 'Bad gateway from key [REDACTED] [BINARY REDACTED] [REDACTED] tail',
          lastFailedAt: now - minute,
          paused: false,
        },
      ],
      generation_successes: { 'gpt-image-2': now - 2 * hour },
      generation_disabled: [],
    })

    // 没在等哪个模型恢复时，不去查成功记录。
    expect((await observeApp({ now })).failures?.generation_successes).toEqual({})
  })

  it('counts slow tasks from submission, including unfinished ones and archive retries', async () => {
    const task = (
      id: string,
      submittedAgo: number,
      tookMs: number | null,
      status: 'completed' | 'failed' | 'in_progress' | 'queued' = 'completed',
      startedAgo = submittedAgo,
    ) => ({
      id,
      provider: 'gemini' as const,
      model: 'slow-alert-model',
      status,
      request_payload: { prompt: 'x', device_id: 'd' },
      submitted_at: now - submittedAgo,
      started_at: now - startedAgo,
      completed_at: tookMs === null ? null : now - submittedAgo + tookMs,
    })
    const rows = [
      task('slow-a', 30 * minute, 5 * minute),
      // 归档重试后最后一次认领只用了几秒：started_at 被覆盖，仍要按提交时间算慢。
      task('slow-archive-retry', 20 * minute, 3 * minute, 'completed', 17 * minute + 10_000),
      task('fast-c', 10 * minute, 30_000),
      task('stuck-d', 4 * minute, null, 'in_progress'),
      // 归档失败回队等重试的任务。
      task('archive-requeued-e', 6 * minute, null, 'queued', 5 * minute),
      task('fresh-f', 30_000, null, 'in_progress'),
      // 从没被认领的积压归 queue 规则，不算进来。
      { ...task('backlog-g', 20 * minute, null, 'queued'), started_at: null },
      // 窗口外的慢任务、失败的慢任务都不算；失败的放在 15 分钟失败窗口外，不影响其他用例。
      task('slow-old', 3 * hour, 5 * minute),
      task('slow-failed', 40 * minute, 5 * minute, 'failed'),
    ]
    await writer.db.insert(writer.schema.tasks).values(rows)
    try {
      const slow = (await observeApp({ now })).slowGenerations?.find(
        (one) => one.model === 'slow-alert-model',
      )
      expect(slow).toMatchObject({
        model: 'slow-alert-model',
        slow: 4,
        completed: 3,
        unfinished: 3,
      })
      // 没结束的按数据库 NOW() 算，比测试里的 now 晚一点点。
      expect(slow?.maxMs).toBeGreaterThanOrEqual(6 * minute)
      expect(slow?.maxMs).toBeLessThan(7 * minute)
    } finally {
      await writer.db.delete(writer.schema.tasks).where(
        inArray(
          writer.schema.tasks.id,
          rows.map((row) => row.id),
        ),
      )
    }
  })

  it('observes log freshness only where observability is configured', async () => {
    expect((await observeApp({ now })).serverLogs).toBeUndefined()
    expect((await observeApp({ now, readLatestLogAt: null })).serverLogs).toBeUndefined()
    expect(
      (await observeApp({ now, readLatestLogAt: async () => now - minute })).serverLogs,
    ).toEqual({ latest_at: now - minute })
    expect((await observeApp({ now, readLatestLogAt: async () => null })).serverLogs).toEqual({
      latest_at: null,
    })
    // 读不到 OpenObserve 是这一块失明，不当成恢复。
    const missed: string[] = []
    const failing = await observeApp({
      now,
      readLatestLogAt: async () => {
        throw new Error('proxy down')
      },
      onMissed: (block) => missed.push(block),
    })
    expect(failing.serverLogs).toBeUndefined()
    expect(missed).toContain('serverLogs')
  })

  it('aggregates upstream spans per provider and model, counting only upstream-side failures', async () => {
    const queries: Array<{ sql: string; type?: string; startMs: number }> = []
    let fields = new Set([
      'operation_name',
      'span_id',
      'upstream_provider',
      'upstream_model',
      'upstream_outcome',
    ])
    const read = upstreamStatsReader({
      search: async (query) => {
        queries.push(query)
        return [{ provider: 'gemini', model: 'veo', requests: 12, failures: '4', throttled: 1 }]
      },
      searchAll: async () => ({ records: [], truncated: false }),
      streamFields: async () => fields,
    })
    expect(await read(now)).toEqual([
      { provider: 'gemini', model: 'veo', requests: 12, failures: 4, throttled: 1 },
    ])
    // 没有 server_address 字段时不按主机分组。
    expect(queries[0]?.sql).toContain("GROUP BY upstream_provider, '', upstream_model")
    // 取消不算请求；连接、读取失败不论状态码都算失败；没有状态码字段时 5xx 与 429 数不出来。
    expect(queries[0]?.sql).toContain("upstream_outcome <> 'aborted'")
    expect(queries[0]?.sql).toContain("upstream_outcome IN ('read_error', 'transport_error')")
    expect(queries[0]?.sql).toContain('COUNT(DISTINCT CASE WHEN NULL = 429 THEN span_id END)')
    expect(queries[0]).toMatchObject({ type: 'traces', startMs: now - 15 * minute })
    fields = new Set([...fields, 'http_response_status_code', 'task_id', 'server_address'])
    await read(now)
    // 直连与网关按实际访问的主机分开统计。
    expect(queries[1]?.sql).toContain('GROUP BY upstream_provider, server_address, upstream_model')
    expect(queries[1]?.sql).toContain(
      "upstream_outcome = 'http_error' AND CAST(http_response_status_code AS BIGINT) >= 500",
    )
    // 同一任务的退避重试只算一次限流。
    expect(queries[1]?.sql).toContain(
      'COUNT(DISTINCT CASE WHEN CAST(http_response_status_code AS BIGINT) = 429 THEN COALESCE(task_id, span_id) END)',
    )
    // 新部署还没有任何 span：不查。
    fields = new Set()
    expect(await read(now)).toEqual([])
    expect(queries).toHaveLength(2)
  })

  it('warns once when spans exist but the upstream fields are gone', async () => {
    const { log } = await import('../../lib/logger')
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    const read = upstreamStatsReader({
      search: async () => [],
      searchAll: async () => ({ records: [], truncated: false }),
      streamFields: async () => new Set(['operation_name', 'span_id']),
    })
    // 读不到不是零请求：抛出去，这一块算失明。
    await expect(read(now)).rejects.toThrow('upstream spans lack')
    await expect(read(now)).rejects.toThrow('upstream spans lack')
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('observes upstream only where observability is configured', async () => {
    expect((await observeApp({ now })).upstream).toBeUndefined()
    const upstream = [{ provider: 'p', model: 'm', requests: 1, failures: 0, throttled: 0 }]
    expect((await observeApp({ now, readUpstream: async () => upstream })).upstream).toEqual(
      upstream,
    )
  })

  it('asks OpenObserve for the newest log in the last hour and converts microseconds', async () => {
    const queries: unknown[] = []
    let latest: unknown = (now - minute) * 1_000
    const read = latestObsLogReader({
      search: async (query) => {
        queries.push(query)
        return latest === undefined ? [] : [{ latest }]
      },
      searchAll: async () => ({ records: [], truncated: false }),
      streamFields: async () => new Set<string>(),
    })
    expect(await read(now)).toBe(now - minute)
    expect(queries[0]).toEqual({
      sql: 'SELECT MAX(_timestamp) AS latest FROM "app"',
      type: 'logs',
      startMs: now - hour,
      endMs: now + minute,
      size: 1,
    })
    for (latest of [null, 0, undefined]) expect(await read(now)).toBeNull()
  })

  it('marks a failing model paused only when it was auto-paused for upstream unavailability', async () => {
    const table = writer.schema.model_availability
    const pausedOf = async () =>
      (await observeApp({ now })).failures?.generation_models?.find(
        (model) => model.model === 'gpt-image-2',
      )?.paused
    await writer.db.insert(table).values({
      model: 'gpt-image-2',
      active: false,
      pause_reason: null,
      paused_at: null,
      updated_at: now,
    })
    try {
      // 运营手动停用：不算自动暂停，不能让告警说「已自动暂停」，但会进入 generation_disabled 以便解除等待。
      expect(await pausedOf()).toBe(false)
      expect((await observeApp({ now })).failures?.generation_disabled).toEqual(['gpt-image-2'])
      await writer.db
        .update(table)
        .set({ pause_reason: 'upstream_unavailable', paused_at: now })
        .where(eq(table.model, 'gpt-image-2'))
      expect(await pausedOf()).toBe(true)
      expect((await observeApp({ now })).failures?.generation_disabled).toEqual([])
    } finally {
      await writer.db.delete(table).where(eq(table.model, 'gpt-image-2'))
    }
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
  it('fires the rules once, then stays quiet, then reports the recovery', async () => {
    // 自己控制日志新鲜度：起初安静，静默超线后也要走 firing → resolved。
    let latestLogAt = now
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
      readLatestLogAt: async () => latestLogAt,
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

    sent.length = 0
    await check(now + 16 * minute)
    expect(sent.map((message) => `${message.kind}:${message.rule}`)).toEqual(['firing:server-logs'])

    latestLogAt = now + 16 * minute
    sent.length = 0
    await check(now + 17 * minute)
    expect(sent.map((message) => `${message.kind}:${message.rule}`)).toEqual([
      'resolved:server-logs',
    ])
  })
  it('asks OpenObserve at most once a minute and judges age against the current time', async () => {
    let reads = 0
    const sent: AlertMessage[] = []
    const check = createAppAlerting({
      send: async (messages) => {
        sent.push(...messages.filter((message) => message.rule === 'server-logs'))
      },
      readBackups: async () => ({ latest: null, previous: null }),
      readRestoreDrill: async () => null,
      readLatestLogAt: async () => {
        reads++
        return now
      },
    })
    for (let second = 0; second < 60; second += 10) await check(now + second * 1_000)
    expect(reads).toBe(1)
    await check(now + minute)
    expect(reads).toBe(2)
    expect(sent).toEqual([])
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

  it('emits a log pipeline heartbeat every 5 minutes when observability is enabled, keeping quiet deployments green until delivery actually stops', async () => {
    let clock = now
    let latestLogAt = now
    let delivering = true
    const heartbeats: number[] = []
    const sent: AlertMessage[] = []
    const check = createAppAlerting({
      send: async (messages) => {
        sent.push(...messages.filter((message) => message.rule === 'server-logs'))
      },
      readBackups: async () => ({ latest: null, previous: null }),
      readRestoreDrill: async () => null,
      readLatestLogAt: async () => latestLogAt,
      emitLogHeartbeat: () => {
        heartbeats.push(clock)
        if (delivering) latestLogAt = clock
      },
    })

    // 模拟低流量静默 15 分钟：含节流缓存边界（4m50s 缓存旧值、5m 发新心跳、5m40s 复用缓存、5m50s 刷新），
    // 不误报断流；且同一间隔内高频 10 秒轮询不会重复打心跳。
    for (const elapsed of [
      0,
      10_000,
      4 * minute + 50_000,
      5 * minute,
      5 * minute + 40_000,
      5 * minute + 50_000,
      10 * minute,
      15 * minute,
    ]) {
      clock = now + elapsed
      await check(clock)
    }
    expect(heartbeats).toEqual([now, now + 5 * minute, now + 10 * minute, now + 15 * minute])
    expect(sent).toEqual([])

    // 模拟采集管道真的断了（心跳不再送达 OpenObserve）：超过 10 分钟线照常告警。
    delivering = false
    for (const elapsed of [20 * minute, 25 * minute, 25 * minute + 10_000]) {
      clock = now + elapsed
      await check(clock)
    }
    expect(heartbeats).toEqual([
      now,
      now + 5 * minute,
      now + 10 * minute,
      now + 15 * minute,
      now + 20 * minute,
      now + 25 * minute,
    ])
    expect(sent.map((message) => `${message.kind}:${message.rule}`)).toEqual(['firing:server-logs'])
  })

  it('skips the log pipeline heartbeat when observability is disabled', async () => {
    let heartbeats = 0
    const check = createAppAlerting({
      send: async () => {},
      readBackups: async () => ({ latest: null, previous: null }),
      readRestoreDrill: async () => null,
      readLatestLogAt: null,
      emitLogHeartbeat: () => {
        heartbeats++
      },
    })
    await check(now)
    await check(now + OPS_THRESHOLDS.SERVER_LOGS_HEARTBEAT_INTERVAL_MS)
    expect(heartbeats).toBe(0)
  })

  it('logs ops.log_pipeline_heartbeat by default and survives emitter failures', async () => {
    const infoSpy = spyOn(log, 'info').mockImplementation(() => {})
    try {
      const check = createAppAlerting({
        send: async () => {},
        readBackups: async () => ({ latest: null, previous: null }),
        readRestoreDrill: async () => null,
        readLatestLogAt: async () => now,
      })
      await check(now)
      await check(now + 4 * minute)
      await check(now + 5 * minute)
      const calls = infoSpy.mock.calls.filter(
        ([fields]) =>
          typeof fields === 'object' &&
          fields !== null &&
          (fields as { event?: string }).event === 'ops.log_pipeline_heartbeat',
      )
      expect(calls.length).toBe(2)
      expect(calls[0]?.[1]).toBe('log pipeline heartbeat')
    } finally {
      infoSpy.mockRestore()
    }

    let attempts = 0
    const sent: AlertMessage[] = []
    const checkWithFaultyHeartbeat = createAppAlerting({
      send: async (messages) => {
        sent.push(...messages.filter((message) => message.rule === 'server-logs'))
      },
      readBackups: async () => ({ latest: null, previous: null }),
      readRestoreDrill: async () => null,
      readLatestLogAt: async () => now - 11 * minute,
      emitLogHeartbeat: () => {
        attempts++
        if (attempts === 1) throw new Error('stdout broken')
      },
    })
    await checkWithFaultyHeartbeat(now)
    // 首次失败不能挡住告警，且不推进心跳时间戳，下一轮立即重试。
    expect(sent.map((message) => `${message.kind}:${message.rule}`)).toEqual(['firing:server-logs'])
    await checkWithFaultyHeartbeat(now + 10_000)
    expect(attempts).toBe(2)
  })
})

it('keeps a smaller configuration failure visible beside a larger overload class', async () => {
  const { eq } = await import('drizzle-orm')
  const conversationId = 'alert-pattern-conversation'
  try {
    await writer.db.insert(writer.schema.agent_conversations).values({
      id: conversationId,
      device_id: 'alert-pattern-device',
      title: 'patterns',
      created_at: now,
      updated_at: now,
    })
    const failure = (message: string) => ({
      code: 'agent_upstream_error' as const,
      message,
      model: 'gpt-6-luna',
      occurredAt: new Date(now).toISOString(),
    })
    await writer.db.insert(writer.schema.agent_turns).values([
      ...[1, 2, 3].map((index) => ({
        conversation_id: conversationId,
        turn_id: `overload-${index}`,
        duration_ms: 1,
        stop_reason: 'failed' as const,
        failure: failure('Our servers are currently overloaded.'),
        created_at: now - minute,
      })),
      {
        conversation_id: conversationId,
        turn_id: 'config-1',
        duration_ms: 1,
        stop_reason: 'failed' as const,
        failure: failure(
          '400: {"message":"Invalid value: \'off\'.","type":"invalid_request_error"}',
        ),
        created_at: now - minute,
      },
      {
        conversation_id: conversationId,
        turn_id: 'auth-1',
        duration_ms: 1,
        stop_reason: 'failed' as const,
        failure: failure('Chat upstream returned 401: invalid api key'),
        created_at: now - minute,
      },
      {
        conversation_id: conversationId,
        turn_id: 'missing-model-1',
        duration_ms: 1,
        stop_reason: 'failed' as const,
        failure: failure('Upstream HTTP 404'),
        created_at: now - minute,
      },
    ])
    const observation = await observeApp({
      now,
      readBackups: async () => ({ latest: null, previous: null }),
      readRestoreDrill: async () => null,
    })
    const patterns = observation.agentFailurePatterns ?? []
    expect(patterns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ turns: 3, upstreamStatus: null, code: 'agent_upstream_error' }),
        expect.objectContaining({ turns: 1, upstreamStatus: 400, code: 'agent_upstream_error' }),
        expect.objectContaining({ turns: 1, upstreamStatus: 401, code: 'agent_upstream_error' }),
        expect.objectContaining({ turns: 1, upstreamStatus: 404, code: 'agent_upstream_error' }),
      ]),
    )
  } finally {
    await writer.db
      .delete(writer.schema.agent_turns)
      .where(eq(writer.schema.agent_turns.conversation_id, conversationId))
    await writer.db
      .delete(writer.schema.agent_conversations)
      .where(eq(writer.schema.agent_conversations.id, conversationId))
  }
})

it('aggregates error minute counts across instances without counting client errors as successes', async () => {
  const { eq } = await import('drizzle-orm')
  const errorMinute = Math.floor((now - 3 * minute) / minute) * minute
  const instances = ['alert-errors-one', 'alert-errors-two']
  try {
    await writer.db.insert(writer.schema.api_minutes).values([
      {
        minute: errorMinute,
        instance: instances[0]!,
        requests: 3,
        client_errors: 1,
        server_errors: 2,
        server_error_routes: { 'POST /api/media/:id/complete': 2 },
      },
      {
        minute: errorMinute,
        instance: instances[1]!,
        requests: 3,
        client_errors: 0,
        server_errors: 3,
        server_error_routes: { 'POST /api/media/:id/complete': 3 },
      },
      {
        minute: Math.floor(now / minute) * minute,
        instance: instances[1]!,
        requests: 2,
        client_errors: 2,
        server_errors: 0,
      },
    ])
    const observation = await observeApp({
      now,
      readBackups: async () => ({ latest: null, previous: null }),
      readRestoreDrill: async () => null,
    })
    expect(observation.api).toEqual({
      requests: 28,
      server_errors: 5,
      errors_by_minute: { [errorMinute]: 5 },
      successes_by_minute: { [Math.floor((now - minute) / minute) * minute]: 20 },
      error_routes: { 'POST /api/media/:id/complete': 5 },
    })
  } finally {
    for (const instance of instances)
      await writer.db
        .delete(writer.schema.api_minutes)
        .where(eq(writer.schema.api_minutes.instance, instance))
  }
})

it('logs safe storage diagnostics and preserves backup-watch blindness and recovery', async () => {
  const { log } = await import('../../lib/logger')
  const { OPS_THRESHOLDS } = await import('@image-playground/shared')
  const warn = spyOn(log, 'warn').mockImplementation(() => {})
  const sent: AlertMessage[] = []
  let failed = true
  let drillLists = 0
  const secret = 'fixture-signature-never-log'
  const error = new OpsStorageError(
    'read',
    Object.assign(new Error(`https://store.invalid/?X-Amz-Signature=${secret}`), {
      code: 'InternalError',
      status: 503,
      cause: Object.assign(new Error(secret), { code: 'ECONNRESET' }),
    }),
  )
  const check = createAppAlerting({
    send: async (messages) => {
      sent.push(...messages)
    },
    readBackups: async () => ({ latest: null, previous: null }),
    readRestoreDrill: async () => {
      drillLists++
      if (failed) throw error
      return null
    },
  })
  const blind = () => sent.filter((message) => message.rule === 'blind')
  const interval = OPS_THRESHOLDS.BACKUP_WATCH_INTERVAL_MS
  try {
    await check(now)
    await check(now + minute)
    expect(blind()).toEqual([])
    expect(drillLists).toBe(1)
    await check(now + interval)
    expect(blind().map((message) => message.kind)).toEqual(['firing'])
    expect(drillLists).toBe(2)
    expect(warn.mock.calls[0]?.[0]).toEqual({
      event: 'ops.alert_observe_failed',
      block: 'restoreDrill',
      stage: 'read',
      err: 'Object storage observation failed (read)',
      storage_error: {
        code: 'InternalError',
        status: 503,
        reason: 'details_omitted',
        cause: { code: 'ECONNRESET', reason: 'details_omitted' },
      },
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret)
    failed = false
    await check(now + interval * 2)
    expect(blind().map((message) => message.kind)).toEqual(['firing', 'resolved'])
    expect(drillLists).toBe(3)
    failed = true
    await check(now + interval * 3)
    await check(now + interval * 3 + minute)
    expect(blind()).toHaveLength(2)
    expect(drillLists).toBe(4)
  } finally {
    warn.mockRestore()
  }
})

it('reuses a successful backup list between intervals so a stale backup still alerts on the wall clock', async () => {
  const { OPS_THRESHOLDS } = await import('@image-playground/shared')
  const sent: AlertMessage[] = []
  let lists = 0
  const modifiedAt = now - (OPS_THRESHOLDS.BACKUP_MAX_AGE_MS - 2 * minute)
  const check = createAppAlerting({
    send: async (messages) => {
      sent.push(...messages)
    },
    readBackups: async () => {
      lists++
      return {
        latest: { key: 'pg/x.dump', size_bytes: 1, modified_at: modifiedAt },
        previous: null,
      }
    },
    readRestoreDrill: async () => null,
  })
  await check(now)
  expect(sent.filter((message) => message.rule === 'backup')).toEqual([])
  await check(now + 3 * minute)
  expect(lists).toBe(1)
  expect(
    sent.filter((message) => message.rule === 'backup').map((message) => message.kind),
  ).toEqual(['firing'])
})

import { createObsClient, type ObsClient, obsConnectionFromEnv } from '@image-playground/node-kit'
import {
  type AgentFailurePattern,
  type AlertObservation,
  type AlertState,
  evaluateAlerts,
  OBS_STREAM,
  OPS_THRESHOLDS,
  type OpsBackups,
  type OpsRestoreDrill,
} from '@image-playground/shared'
import { and, desc, eq, sql } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'
import { log } from '../lib/logger'
import {
  readBackups as readBackupsFromStore,
  readRestoreDrill as readRestoreDrillFromStore,
} from '../lib/ops-backups'
import { OpsStorageError } from '../lib/ops-storage-error'
import { redactLogText } from '../lib/server-log-buffer'
import { directBudgetCapMicroUsd, directSpentThisMonth } from '../lib/upstream/gpt-budget'
import { disabledDirectKeys } from '../lib/upstream/gpt-keys'
import { selectRunnableTasks } from '../workers/runnable-tasks'
import type { AlertSender } from './alert-sender'
import { createBackupWatch, createThrottledRead, isBackupWatchDeferred } from './backup-watch'

/**
 * 应用层的告警由 worker 的维护循环检查；接口与业务失败只读现有的汇总/事实表。
 * 宿主机那两条不在这里，由采集容器自己发（ADR 0018）。
 *
 * worker 不判断自己的心跳：发告警的就是它，它挂了这条本来也发不出来。
 */

/** 读最新一条日志的时间（毫秒）；窗口里一条都没有时为 null。null 表示这个部署没开观测。 */
type LatestLogReader = ((now: number) => Promise<number | null>) | null

/** 断流观测只看最近这么久：够覆盖告警线和进程重启，又不让每分钟一次的查询扫太多分区。 */
const LATEST_LOG_WINDOW_MS = 60 * 60_000
/** 断流观测最多每分钟真正查一次。 */
const LATEST_LOG_INTERVAL_MS = 60_000

/**
 * 日志管道的新鲜度从 OpenObserve 读（ADR 0033 P3）：容器日志经 Fluent Bit → Collector 写进
 * `app` 流，这里取最新一条的时间。宿主机采样、备份等周期日志保证低流量部署也每分钟有新行。
 */
export function latestObsLogReader(client: ObsClient): (now: number) => Promise<number | null> {
  return async (now) => {
    const [row] = await client.search({
      sql: `SELECT MAX(_timestamp) AS latest FROM "${OBS_STREAM}"`,
      type: 'logs',
      startMs: now - LATEST_LOG_WINDOW_MS,
      endMs: now + 60_000,
      size: 1,
    })
    const latest = Number(row?.latest)
    // _timestamp 是微秒。
    return Number.isFinite(latest) && latest > 0 ? Math.floor(latest / 1_000) : null
  }
}

function latestLogReaderFromEnv(): LatestLogReader {
  const connection = obsConnectionFromEnv()
  return connection ? latestObsLogReader(createObsClient(connection, { timeoutMs: 15_000 })) : null
}

interface ObserveOptions {
  now: number
  /** 默认按 `OBS_PROXY_URL`/`OBS_PROXY_TOKEN` 读 OpenObserve，没配为 null（不观测）。测试注入。 */
  readLatestLogAt?: LatestLogReader
  /** 这一轮取不到读数的块；调用方据此累计“失明”轮数。 */
  onMissed?: (block: string) => void
  /** 这一轮真正尝试读取了的块（成功或失败都算；被节流跳过的不算）。 */
  onAttempted?: (block: string) => void
  readBackups?: () => Promise<OpsBackups>
  readRestoreDrill?: () => Promise<OpsRestoreDrill | null>
  /**
   * 还在等它重新出图的模型（告警状态里的等待名单）。名单空着就不查成功记录：没出事时每轮只多一条
   * 与原来失败计数同条件的查询。
   */
  watchingModels?: readonly string[]
}

async function attempt<T>(
  block: string,
  read: () => Promise<T>,
  onMissed?: (block: string) => void,
  onAttempted?: (block: string) => void,
): Promise<T | undefined> {
  try {
    const value = await read()
    onAttempted?.(block)
    return value
  } catch (error) {
    if (isBackupWatchDeferred(error)) return undefined
    onAttempted?.(block)
    onMissed?.(block)
    log.warn(
      {
        event: 'ops.alert_observe_failed',
        block,
        ...(error instanceof OpsStorageError
          ? { stage: error.stage, storage_error: error.storageError }
          : {}),
        err: error instanceof Error ? redactLogText(error.message) : String(error),
      },
      'could not read a block for alerting; its rule is skipped this round',
    )
    return undefined
  }
}

/** 每一块独立取：取不到的那一块留空，对应的规则这一轮既不触发也不被当成已恢复。 */
export async function observeApp(options: ObserveOptions): Promise<AlertObservation> {
  const readBackups = options.readBackups ?? readBackupsFromStore
  const readRestoreDrill = options.readRestoreDrill ?? readRestoreDrillFromStore
  const readLatestLogAt =
    options.readLatestLogAt === undefined ? latestLogReaderFromEnv() : options.readLatestLogAt
  const missed = options.onMissed
  const attempted = options.onAttempted
  const [
    queue,
    backup,
    restoreDrill,
    heartbeats,
    api,
    failures,
    agentFailurePatterns,
    serverLogs,
    slowGenerations,
  ] = await Promise.all([
    attempt(
      'queue',
      async () => {
        const candidates = await Promise.all([
          selectRunnableTasks('openai-compat', 1, options.now, {
            excludeArchived: true,
            orderByEligible: true,
          }),
          selectRunnableTasks('gemini', 1, options.now, {
            excludeArchived: true,
            orderByEligible: true,
          }),
        ])
        const oldest = candidates
          .flat()
          .reduce<number | null>(
            (current, task) =>
              current === null ? task.eligibleSince : Math.min(current, task.eligibleSince),
            null,
          )
        return {
          oldest_queued_wait_ms: oldest === null ? null : Math.max(0, options.now - oldest),
        }
      },
      missed,
      attempted,
    ),
    attempt(
      'backup',
      async () => {
        const { latest } = await readBackups()
        return { latest_modified_at: latest?.modified_at ?? null }
      },
      missed,
      attempted,
    ),
    attempt('restoreDrill', readRestoreDrill, missed, attempted),
    attempt(
      'heartbeats',
      async () => {
        const [row] = await db
          .select({ last_seen_at: schema.service_heartbeats.last_seen_at })
          .from(schema.service_heartbeats)
          .where(and(eq(schema.service_heartbeats.service, 'bff')))
          .orderBy(desc(schema.service_heartbeats.last_seen_at))
          .limit(1)
        return { bff: row?.last_seen_at ?? null }
      },
      missed,
      attempted,
    ),
    attempt(
      'api',
      async () => {
        const rows = (await db.execute(sql`
        SELECT EXTRACT(EPOCH FROM minute) * 1000 AS minute,
          requests, client_errors, server_errors, server_error_routes
        FROM api_minutes
        WHERE minute >= to_timestamp(${options.now / 1000}) - INTERVAL '15 minutes'
          AND minute <= to_timestamp(${options.now / 1000})
      `)) as unknown as Array<{
          minute: string
          requests: number
          client_errors: number
          server_errors: number
          server_error_routes: Record<string, number> | null
        }>
        const api: NonNullable<AlertObservation['api']> = {
          requests: 0,
          server_errors: 0,
          errors_by_minute: {},
          successes_by_minute: {},
          error_routes: {},
        }
        for (const row of rows) {
          const minute = Number(row.minute)
          api.requests += Number(row.requests)
          api.server_errors += Number(row.server_errors)
          if (row.server_errors > 0)
            api.errors_by_minute[minute] =
              (api.errors_by_minute[minute] ?? 0) + Number(row.server_errors)
          if (row.requests > row.client_errors + row.server_errors)
            api.successes_by_minute[minute] =
              (api.successes_by_minute[minute] ?? 0) +
              row.requests -
              row.client_errors -
              row.server_errors
          for (const [route, count] of Object.entries(row.server_error_routes ?? {}))
            api.error_routes[route] = (api.error_routes[route] ?? 0) + count
        }
        return api
      },
      missed,
      attempted,
    ),
    attempt(
      'failures',
      async () => {
        const watching = [...new Set(options.watchingModels ?? [])]
        const [agentRaw, modelsRaw, successesRaw, disabledRaw] = await Promise.all([
          db.execute(sql`
          SELECT COUNT(*) AS count FROM agent_turns
          WHERE stop_reason = 'failed' AND created_at >= NOW() - INTERVAL '15 minutes'
        `),
          // 每个模型一行：失败次数，加上最近一次失败的类型、上游状态码和报错前 200 字。
          // 系统失败总数就是各行之和，不再单独查一遍。
          db.execute(sql`
          WITH failed AS (
            SELECT t.id, t.model, t.error_type, t.upstream_status, t.completed_at
            FROM tasks t
            WHERE t.kind = 'queue' AND t.status = 'failed'
              AND t.error_type IS DISTINCT FROM 'content_policy'
              AND t.completed_at >= NOW() - INTERVAL '15 minutes'
              -- 用提交时间收窄到近 7 天（走 idx_tasks_submitted_at），不必为告警再加索引和迁移。
              -- 任务从提交到结束远短于 7 天（上游硬超时 15 分钟、结果确认 30 分钟就告警），不会漏算。
              AND t.submitted_at >= NOW() - INTERVAL '7 days'
          ),
          -- 每个模型最近一条失败，只扫一遍窗口；原文按主键回表只读这一条的完整文本
          -- （先截断再脱敏会把截在边界上的半截密钥漏出去），不把窗口内每条原文都聚合出来。
          latest AS (
            SELECT DISTINCT ON (f.model) f.model, f.id, f.error_type, f.upstream_status
            FROM failed f
            ORDER BY f.model, f.completed_at DESC, f.id DESC
          ),
          counts AS (
            SELECT f.model, COUNT(*) AS failures, MAX(f.completed_at) AS last_failed
            FROM failed f
            GROUP BY f.model
          )
          SELECT c.model,
            c.failures,
            l.error_type,
            l.upstream_status,
            COALESCE(lt.error_message, '') AS message,
            EXTRACT(EPOCH FROM c.last_failed) * 1000 AS last_failed_at,
            -- 只算因上游不可用被自动暂停的；运营手动停用会清掉 pause_reason，不算。
            COALESCE(m.active = false AND m.pause_reason = 'upstream_unavailable', false) AS paused
          FROM counts c
          JOIN latest l ON l.model = c.model
          JOIN tasks lt ON lt.id = l.id
          LEFT JOIN model_availability m ON m.model = c.model
          ORDER BY failures DESC, last_failed_at DESC
        `),
          // 恢复看的是「出事后这个模型有没有真的出过图」，不是失败数掉没掉。只查等待名单里的模型；
          // 窗口相对现在：名单每轮都对一遍，成功一发生就在窗口里，多晚恢复都看得见。
          watching.length === 0
            ? Promise.resolve([])
            : db.execute(sql`
          SELECT model, EXTRACT(EPOCH FROM MAX(completed_at)) * 1000 AS last_succeeded_at
          FROM tasks
          WHERE kind = 'queue' AND status = 'completed'
            AND model IN (${sql.join(
              watching.map((model) => sql`${model}`),
              sql`, `,
            )})
            AND completed_at >= NOW() - INTERVAL '24 hours'
            AND submitted_at >= NOW() - INTERVAL '8 days'
          GROUP BY model
        `),
          // 运营手动下架的模型不会再出图，交给告警判断从等待恢复名单里划掉；自动暂停的仍留在名单里继续提醒。
          db.execute(sql`
          SELECT model
          FROM model_availability
          WHERE active = false AND pause_reason IS NULL
          ORDER BY model
        `),
        ])
        const agentRows = agentRaw as unknown as Array<Record<string, unknown>>
        const modelRows = modelsRaw as unknown as Array<Record<string, unknown>>
        const successRows = successesRaw as unknown as Array<Record<string, unknown>>
        const disabledRows = disabledRaw as unknown as Array<Record<string, unknown>>
        return {
          generation_system: modelRows.reduce((sum, row) => sum + Number(row.failures ?? 0), 0),
          agent: Number(agentRows[0]?.count ?? 0),
          generation_models: modelRows.map((row) => ({
            model: String(row.model ?? 'unknown'),
            failures: Number(row.failures ?? 0),
            errorType: String(row.error_type ?? 'unknown'),
            upstreamStatus: row.upstream_status == null ? null : Number(row.upstream_status),
            // 报错原文会外发到值班 webhook：先按服务端日志的规则抹掉令牌、密钥和带账号的地址，再截 200 字。
            message: redactLogText(String(row.message ?? '')).slice(0, 200),
            lastFailedAt: Number(row.last_failed_at ?? 0),
            paused: row.paused === true,
          })),
          generation_successes: Object.fromEntries(
            successRows.map((row) => [String(row.model), Number(row.last_succeeded_at ?? 0)]),
          ),
          generation_disabled: disabledRows.map((row) => String(row.model)),
        }
      },
      missed,
      attempted,
    ),
    attempt('agentFailurePatterns', readAgentFailurePatterns, missed, attempted),
    // 没开观测（测试环境）就不给这一块：没有管道可言，缺失也不会被当成已恢复。
    readLatestLogAt
      ? attempt(
          'serverLogs',
          async () => ({ latest_at: await readLatestLogAt(options.now) }),
          missed,
          attempted,
        )
      : undefined,
    attempt('slowGenerations', readSlowGenerations, missed, attempted),
  ])
  // 没开直连就不给这一块：没有预算可言，缺失也不会被当成已恢复。
  const gptDirectBudget = config.gptDirect.enabled
    ? await attempt(
        'gptDirectBudget',
        async () => ({
          spent_micro_usd: await directSpentThisMonth(options.now),
          cap_micro_usd: directBudgetCapMicroUsd(),
        }),
        missed,
        attempted,
      )
    : undefined
  const gptDirectKeys = config.gptDirect.enabled
    ? await attempt(
        'gptDirectKeys',
        async () => ({ disabled: await disabledDirectKeys() }),
        missed,
        attempted,
      )
    : undefined
  return {
    queue,
    backup,
    restoreDrill,
    heartbeats,
    api,
    failures,
    agentFailurePatterns,
    serverLogs,
    slowGenerations,
    ...(gptDirectBudget ? { gptDirectBudget } : {}),
    ...(gptDirectKeys ? { gptDirectKeys } : {}),
  }
}

/**
 * 近 1 小时出过慢任务的模型，耗时按用户感受算：从提交到完成，含排队、渠道排队、Vertex 限流退避
 * 与归档重试。不用 started_at：每次认领都会覆盖它，归档失败回队重试后只剩最后一次的耗时。
 * 还没结束、已经超过慢线的任务也算慢：模型卡住或归档反复失败时近 1 小时没有成功任务，
 * 只看成功任务会误报恢复。从没被认领的纯积压留给 queue 规则，不重复报。
 */
async function readSlowGenerations(): Promise<NonNullable<AlertObservation['slowGenerations']>> {
  const windowSeconds = OPS_THRESHOLDS.SLOW_GENERATION_WINDOW_MS / 1000
  const slowSeconds = OPS_THRESHOLDS.SLOW_GENERATION_MS / 1000
  // 提交时间下限只用来走 idx_tasks_status_submitted：任务从提交到结束远短于 1 天。
  const rows = (await db.execute(sql`
    SELECT model,
      COUNT(*) FILTER (
        WHERE COALESCE(completed_at, NOW()) - submitted_at > make_interval(secs => ${slowSeconds})
      ) AS slow,
      COUNT(*) FILTER (WHERE status = 'completed') AS completed,
      COUNT(*) FILTER (WHERE status <> 'completed') AS unfinished,
      MAX(EXTRACT(EPOCH FROM COALESCE(completed_at, NOW()) - submitted_at)) * 1000 AS max_ms
    FROM tasks
    WHERE kind = 'queue' AND started_at IS NOT NULL
      AND submitted_at >= NOW() - INTERVAL '1 day'
      AND (
        (status = 'completed' AND completed_at >= NOW() - make_interval(secs => ${windowSeconds}))
        OR status IN ('queued', 'in_progress', 'reconciling')
      )
    GROUP BY model
    HAVING COUNT(*) FILTER (
      WHERE COALESCE(completed_at, NOW()) - submitted_at > make_interval(secs => ${slowSeconds})
    ) > 0
  `)) as unknown as Array<Record<string, unknown>>
  return rows.map((row) => ({
    model: String(row.model ?? 'unknown'),
    slow: Number(row.slow ?? 0),
    completed: Number(row.completed ?? 0),
    unfinished: Number(row.unfinished ?? 0),
    maxMs: Math.round(Number(row.max_ms ?? 0)),
  }))
}

/** 近 6 小时每一类失败：同一模型、错误码与上游状态码各算一类，互不挤掉。 */
async function readAgentFailurePatterns(): Promise<AgentFailurePattern[]> {
  const windowSeconds = OPS_THRESHOLDS.AGENT_FAILURE_PATTERN_WINDOW_MS / 1000
  const rows = (await db.execute(sql`
    SELECT failure->>'model' AS model,
      failure->>'code' AS code,
      (regexp_match(
        failure->>'message',
        '(^|[Rr]eturned[[:space:]]+|[Hh][Tt][Tt][Pp][[:space:]]+)([0-9]{3})([^0-9]|$)'
      ))[2] AS status,
      COUNT(DISTINCT turn_id) AS turns,
      EXTRACT(EPOCH FROM MAX(created_at)) * 1000 AS last_at,
      (array_agg(failure->>'message' ORDER BY created_at DESC))[1] AS message
    FROM agent_turns
    WHERE stop_reason = 'failed' AND failure IS NOT NULL
      AND COALESCE(failure->>'code', '') <> 'content_policy'
      AND COALESCE(failure->>'message', '') NOT ILIKE '%content_policy%'
      AND created_at >= NOW() - ${windowSeconds} * INTERVAL '1 second'
    GROUP BY 1, 2, 3
    ORDER BY turns DESC, last_at DESC
  `)) as unknown as Array<Record<string, unknown>>
  return rows.map((row) => ({
    model: String(row.model ?? 'unknown'),
    code: String(row.code ?? 'unknown'),
    upstreamStatus: row.status ? Number(row.status) : null,
    turns: Number(row.turns ?? 0),
    lastAt: Number(row.last_at ?? 0),
    message: String(row.message ?? '').slice(0, 200),
  }))
}

interface AppAlertingOptions {
  send: AlertSender
  readBackups?: () => Promise<OpsBackups>
  readRestoreDrill?: () => Promise<OpsRestoreDrill | null>
  /** 备份和演练列出的最短间隔；默认 5 分钟。测试可改短。 */
  backupWatchIntervalMs?: number
  readLatestLogAt?: LatestLogReader
}

/**
 * 返回一个「看一眼、该发就发」的函数，给维护循环调。它从不抛出：告警自己出问题不该牵连任务处理。
 * 状态放在闭包里，进程重启后最多重发一次；发送失败时状态不前进，下一轮再试。
 */
export function createAppAlerting(options: AppAlertingOptions): (now?: number) => Promise<void> {
  let state: AlertState = {}
  let pending = false
  let again = false
  const blindRounds = new Map<string, number>()
  const latestLogReader =
    options.readLatestLogAt === undefined ? latestLogReaderFromEnv() : options.readLatestLogAt
  // 维护循环每 10 秒扫一次告警；OpenObserve 的聚合每分钟查一次就够，间隔内复用上次成功的读数，
  // 年龄仍按当前时间算。
  const readLatestLogAt = latestLogReader
    ? createThrottledRead(latestLogReader, LATEST_LOG_INTERVAL_MS)
    : null
  const backupWatch = createBackupWatch({
    intervalMs: options.backupWatchIntervalMs ?? OPS_THRESHOLDS.BACKUP_WATCH_INTERVAL_MS,
    readBackups: options.readBackups ?? readBackupsFromStore,
    readRestoreDrill: options.readRestoreDrill ?? readRestoreDrillFromStore,
  })
  return async (now = Date.now()) => {
    // 停用密钥的请求会再踢一轮。正在扫的时候踢到，等这一轮结束马上再扫，不丢这次告警。
    if (pending) {
      again = true
      return
    }
    pending = true
    try {
      let roundNow = now
      do {
        again = false
        const missed = new Set<string>()
        const attempted = new Set<string>()
        const observation = await observeApp({
          now: roundNow,
          readBackups: () => backupWatch.readBackups(roundNow),
          readRestoreDrill: () => backupWatch.readRestoreDrill(roundNow),
          watchingModels: Object.keys(state.generationWatch ?? {}),
          readLatestLogAt,
          onMissed: (block) => missed.add(block),
          onAttempted: (block) => attempted.add(block),
        })
        // 被节流跳过的块既不加轮次，也不清零；只有这一轮真正读到了才算恢复。
        for (const block of [...blindRounds.keys()]) {
          if (attempted.has(block) && !missed.has(block)) blindRounds.delete(block)
        }
        for (const block of missed) blindRounds.set(block, (blindRounds.get(block) ?? 0) + 1)
        const result = evaluateAlerts(
          {
            ...observation,
            blindBlocks: [...blindRounds].map(([block, rounds]) => ({ block, rounds })),
          },
          state,
          roundNow,
        )
        roundNow = Date.now()
        if (result.messages.length > 0) await options.send(result.messages)
        state = result.state
      } while (again)
    } catch (error) {
      log.warn(
        { event: 'ops.alert_failed', err: error instanceof Error ? error.message : String(error) },
        'operations alert round failed; it will be retried on the next scan',
      )
    } finally {
      pending = false
    }
  }
}

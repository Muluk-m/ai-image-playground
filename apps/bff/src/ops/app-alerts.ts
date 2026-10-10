import {
  type AlertObservation,
  type AlertState,
  evaluateAlerts,
  type OpsBackups,
  type OpsRestoreDrill,
} from '@image-playground/shared'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { log } from '../lib/logger'
import {
  readBackups as readBackupsFromStore,
  readRestoreDrill as readRestoreDrillFromStore,
} from '../lib/ops-backups'
import { selectRunnableTasks } from '../workers/runnable-tasks'
import type { AlertSender } from './alert-sender'

/**
 * 应用层的告警由 worker 的维护循环检查；接口与业务失败只读现有的汇总/事实表。
 * 宿主机那两条不在这里，由采集容器自己发（ADR 0018）。
 *
 * worker 不判断自己的心跳：发告警的就是它，它挂了这条本来也发不出来。
 */

interface ObserveOptions {
  now: number
  readBackups?: () => Promise<OpsBackups>
  readRestoreDrill?: () => Promise<OpsRestoreDrill | null>
}

async function attempt<T>(block: string, read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  } catch (error) {
    log.warn(
      {
        event: 'ops.alert_observe_failed',
        block,
        err: error instanceof Error ? error.message : String(error),
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
  const [queue, backup, restoreDrill, heartbeats, api, failures] = await Promise.all([
    attempt('queue', async () => {
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
      return { oldest_queued_wait_ms: oldest === null ? null : Math.max(0, options.now - oldest) }
    }),
    attempt('backup', async () => {
      const { latest } = await readBackups()
      return { latest_modified_at: latest?.modified_at ?? null }
    }),
    attempt('restoreDrill', readRestoreDrill),
    attempt('heartbeats', async () => {
      const [row] = await db
        .select({ last_seen_at: schema.service_heartbeats.last_seen_at })
        .from(schema.service_heartbeats)
        .where(and(eq(schema.service_heartbeats.service, 'bff')))
        .orderBy(desc(schema.service_heartbeats.last_seen_at))
        .limit(1)
      return { bff: row?.last_seen_at ?? null }
    }),
    attempt('api', async () => {
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
    }),
    attempt('failures', async () => {
      const [generationRaw, agentRaw] = await Promise.all([
        db.execute(sql`
          SELECT COUNT(*) AS count FROM tasks
          WHERE kind = 'queue' AND status = 'failed'
            AND error_type IS DISTINCT FROM 'content_policy'
            AND completed_at >= NOW() - INTERVAL '15 minutes'
        `),
        db.execute(sql`
          SELECT COUNT(*) AS count FROM agent_turns
          WHERE stop_reason = 'failed' AND created_at >= NOW() - INTERVAL '15 minutes'
        `),
      ])
      const generationRows = generationRaw as unknown as Array<Record<string, unknown>>
      const agentRows = agentRaw as unknown as Array<Record<string, unknown>>
      return {
        generation_system: Number(generationRows[0]?.count ?? 0),
        agent: Number(agentRows[0]?.count ?? 0),
      }
    }),
  ])
  return { queue, backup, restoreDrill, heartbeats, api, failures }
}

interface AppAlertingOptions {
  send: AlertSender
  readBackups?: () => Promise<OpsBackups>
  readRestoreDrill?: () => Promise<OpsRestoreDrill | null>
}

/**
 * 返回一个「看一眼、该发就发」的函数，给维护循环调。它从不抛出：告警自己出问题不该牵连任务处理。
 * 状态放在闭包里，进程重启后最多重发一次；发送失败时状态不前进，下一轮再试。
 */
export function createAppAlerting(options: AppAlertingOptions): (now?: number) => Promise<void> {
  let state: AlertState = {}
  let pending = false
  return async (now = Date.now()) => {
    if (pending) return
    pending = true
    try {
      const observation = await observeApp({
        now,
        readBackups: options.readBackups,
        readRestoreDrill: options.readRestoreDrill,
      })
      const result = evaluateAlerts(observation, state, now)
      if (result.messages.length > 0) await options.send(result.messages)
      state = result.state
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

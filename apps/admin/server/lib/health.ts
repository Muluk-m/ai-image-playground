import { sql } from 'drizzle-orm'
import {
  DEFAULT_HEALTH_RANGE,
  HEALTH_RANGE_META,
  type HealthMonitorSnapshot,
  type HealthRange,
  type TaskListItem,
} from '../../contracts'
import { getDbHandle } from './db'
import {
  buildHealthMonitorSnapshot,
  type RawAgentBucketRow,
  type RawAgentSummaryRow,
  type RawApiBucketRow,
  type RawGenerationBucketRow,
  type RawGenerationSummaryRow,
} from './health-aggregate'

export {
  buildHealthMonitorSnapshot,
  classifyBucketStatus,
  deriveCurrentStatus,
  HEALTH_THRESHOLDS,
  worstStatus,
} from './health-aggregate'

/** 用提交时间下界裁剪 `tasks` 历史分区（48h 裕量覆盖慢任务/对账任务）。 */
const GENERATION_SUBMITTED_LOOKBACK_SEC = 48 * 3600
/** 短 TTL 缓存 + 同参数并发合并，避免多管理员/多标签页 30 秒轮询放大只读库聚合负载。 */
const HEALTH_CACHE_TTL_MS = 15_000

interface CachedHealthEntry {
  readonly expiresAt: number
  readonly snapshot: HealthMonitorSnapshot
}

const healthCache = new Map<string, CachedHealthEntry>()
const healthInFlight = new Map<string, Promise<HealthMonitorSnapshot>>()

export function resetHealthMonitorCacheForTesting(): void {
  healthCache.clear()
  healthInFlight.clear()
}

function optionalMs(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const num = Number(value)
  return Number.isFinite(num) && num >= 0 ? Math.round(num) : null
}

/** 从只读库并行读取生成任务、Agent 模型调用（含 TTFT）与核心接口健康数据（3 条 GROUPING SETS 单次扫描，带短缓存与并发合并）。 */
export async function readHealthMonitor(
  range: HealthRange = DEFAULT_HEALTH_RANGE,
  includePolicy = false,
  explicitNow?: number,
): Promise<HealthMonitorSnapshot> {
  if (explicitNow !== undefined) {
    return queryHealthMonitor(range, includePolicy, explicitNow)
  }

  const cacheKey = `${process.env.DATABASE_URL ?? ''}|${range}|${includePolicy ? '1' : '0'}`
  const cached = healthCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.snapshot
  }

  const existing = healthInFlight.get(cacheKey)
  if (existing) return existing

  const promise = queryHealthMonitor(range, includePolicy)
    .then((snapshot) => {
      healthCache.set(cacheKey, { expiresAt: Date.now() + HEALTH_CACHE_TTL_MS, snapshot })
      return snapshot
    })
    .finally(() => {
      healthInFlight.delete(cacheKey)
    })
  healthInFlight.set(cacheKey, promise)
  return promise
}

async function queryHealthMonitor(
  range: HealthRange,
  includePolicy: boolean,
  explicitNow?: number,
): Promise<HealthMonitorSnapshot> {
  const { db } = getDbHandle()
  let now = explicitNow
  if (now === undefined) {
    const clockRaw = (await db.execute(
      sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000) AS now_ms`,
    )) as unknown as Array<Record<string, unknown>>
    const dbNow = Number(clockRaw[0]?.now_ms)
    now = Number.isFinite(dbNow) ? dbNow : Date.now()
  }

  const meta = HEALTH_RANGE_META[range]
  const bucketSeconds = meta.bucketSeconds
  const bucketMs = bucketSeconds * 1000
  const currentBucketStart = Math.floor(now / bucketMs) * bucketMs
  const windowStartSec = (currentBucketStart - (meta.bucketCount - 1) * bucketMs) / 1000
  const windowEndSec = (currentBucketStart + bucketMs) / 1000
  const submittedFloorSec = windowStartSec - GENERATION_SUBMITTED_LOOKBACK_SEC

  const [genRaw, agentRaw, apiRaw] = await Promise.all([
    db.execute(sql`
      WITH scoped AS (
        SELECT
          provider,
          model,
          gpt_route,
          EXTRACT(EPOCH FROM date_bin(make_interval(secs => ${bucketSeconds}), completed_at, TIMESTAMPTZ '2000-01-01 00:00:00+00')) * 1000 AS bucket_at,
          status,
          error_type,
          CASE
            WHEN status = 'completed' AND started_at IS NOT NULL AND completed_at >= started_at
            THEN EXTRACT(EPOCH FROM completed_at - started_at) * 1000
          END AS duration_ms,
          -- 仅统计首次尝试的排队耗时（attempt_count 记录已回队失败次数，首次执行为 0），且同步遵守 includePolicy 口径。
          CASE
            WHEN started_at IS NOT NULL
              AND started_at >= submitted_at
              AND attempt_count = 0
              AND (status = 'completed' OR error_type IS DISTINCT FROM 'content_policy' OR ${includePolicy})
            THEN EXTRACT(EPOCH FROM started_at - submitted_at) * 1000
          END AS queue_wait_ms
        FROM queue_tasks
        WHERE completed_at >= to_timestamp(${windowStartSec})
          AND completed_at < to_timestamp(${windowEndSec})
          AND submitted_at >= to_timestamp(${submittedFloorSec})
          AND status IN ('completed', 'failed')
      )
      SELECT
        GROUPING(provider, model, gpt_route, bucket_at) AS grp,
        provider,
        model,
        gpt_route,
        bucket_at,
        COUNT(*) FILTER (WHERE status = 'completed') AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed' AND error_type IS DISTINCT FROM 'content_policy') AS system_failed,
        COUNT(*) FILTER (WHERE status = 'failed' AND error_type = 'content_policy') AS policy_blocked,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS duration_p50_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS duration_p95_ms,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY queue_wait_ms) FILTER (WHERE queue_wait_ms IS NOT NULL) AS queue_wait_p50_ms
      FROM scoped
      GROUP BY GROUPING SETS (
        (provider, model, gpt_route, bucket_at),
        (provider, model, gpt_route),
        ()
      )
    `),
    db.execute(sql`
      WITH scoped AS (
        SELECT
          model,
          -- 终态调用按 finished_at 归桶（缺省回退 started_at），确保长流式调用刚失败时落在最新桶。
          EXTRACT(EPOCH FROM date_bin(make_interval(secs => ${bucketSeconds}), COALESCE(finished_at, started_at), TIMESTAMPTZ '2000-01-01 00:00:00+00')) * 1000 AS bucket_at,
          status,
          CASE WHEN status = 'completed' AND ttft_ms IS NOT NULL THEN ttft_ms END AS valid_ttft_ms,
          CASE
            WHEN status = 'completed' AND finished_at IS NOT NULL AND finished_at >= started_at
            THEN EXTRACT(EPOCH FROM finished_at - started_at) * 1000
          END AS duration_ms
        FROM agent_model_calls
        WHERE started_at >= to_timestamp(${submittedFloorSec})
          AND COALESCE(finished_at, started_at) >= to_timestamp(${windowStartSec})
          AND COALESCE(finished_at, started_at) < to_timestamp(${windowEndSec})
          AND purpose = 'conversation'
          AND status IN ('completed', 'failed')
          AND local_rejection IS NULL
      )
      SELECT
        GROUPING(model, bucket_at) AS grp,
        model,
        bucket_at,
        COUNT(*) FILTER (WHERE status = 'completed') AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY valid_ttft_ms) FILTER (WHERE valid_ttft_ms IS NOT NULL) AS ttft_p50_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY valid_ttft_ms) FILTER (WHERE valid_ttft_ms IS NOT NULL) AS ttft_p95_ms,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS duration_p50_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS duration_p95_ms
      FROM scoped
      GROUP BY GROUPING SETS (
        (model, bucket_at),
        (model),
        ()
      )
    `),
    db.execute(sql`
      WITH scoped AS (
        SELECT
          EXTRACT(EPOCH FROM date_bin(make_interval(secs => ${bucketSeconds}), minute, TIMESTAMPTZ '2000-01-01 00:00:00+00')) * 1000 AS bucket_at,
          requests,
          server_errors,
          p50_ms,
          p95_ms
        FROM api_minutes
        WHERE minute >= to_timestamp(${windowStartSec})
          AND minute < to_timestamp(${windowEndSec})
      )
      SELECT
        GROUPING(bucket_at) AS grp,
        bucket_at,
        COALESCE(SUM(requests), 0) AS requests,
        COALESCE(SUM(server_errors), 0) AS server_errors,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p50_ms) FILTER (WHERE p50_ms IS NOT NULL) AS p50_ms,
        MAX(p95_ms) AS p95_ms
      FROM scoped
      GROUP BY GROUPING SETS (
        (bucket_at),
        ()
      )
    `),
  ])

  const parseRoute = (value: unknown): TaskListItem['gpt_route'] =>
    value === 'direct' || value === 'sub2api' ? value : null

  const generationBuckets: RawGenerationBucketRow[] = []
  const generationSummaries: RawGenerationSummaryRow[] = []
  let generationOverallP50Ms: number | null = null

  for (const row of genRaw as unknown as Array<Record<string, unknown>>) {
    const grp = Number(row.grp)
    if (grp === 0) {
      generationBuckets.push({
        provider: String(row.provider),
        model: String(row.model),
        gpt_route: parseRoute(row.gpt_route),
        bucket_at: Math.round(Number(row.bucket_at)),
        succeeded: Number(row.succeeded ?? 0),
        system_failed: Number(row.system_failed ?? 0),
        policy_blocked: Number(row.policy_blocked ?? 0),
        duration_p50_ms: optionalMs(row.duration_p50_ms),
        duration_p95_ms: optionalMs(row.duration_p95_ms),
        queue_wait_p50_ms: optionalMs(row.queue_wait_p50_ms),
      })
    } else if (grp === 1) {
      generationSummaries.push({
        provider: String(row.provider),
        model: String(row.model),
        gpt_route: parseRoute(row.gpt_route),
        succeeded: Number(row.succeeded ?? 0),
        system_failed: Number(row.system_failed ?? 0),
        policy_blocked: Number(row.policy_blocked ?? 0),
        duration_p50_ms: optionalMs(row.duration_p50_ms),
        duration_p95_ms: optionalMs(row.duration_p95_ms),
        queue_wait_p50_ms: optionalMs(row.queue_wait_p50_ms),
      })
    } else if (grp === 15) {
      generationOverallP50Ms = optionalMs(row.duration_p50_ms)
    }
  }

  const agentBuckets: RawAgentBucketRow[] = []
  const agentSummaries: RawAgentSummaryRow[] = []
  let agentOverallTtftP50Ms: number | null = null

  for (const row of agentRaw as unknown as Array<Record<string, unknown>>) {
    const grp = Number(row.grp)
    if (grp === 0) {
      agentBuckets.push({
        model: String(row.model),
        bucket_at: Math.round(Number(row.bucket_at)),
        succeeded: Number(row.succeeded ?? 0),
        failed: Number(row.failed ?? 0),
        ttft_p50_ms: optionalMs(row.ttft_p50_ms),
        ttft_p95_ms: optionalMs(row.ttft_p95_ms),
        duration_p50_ms: optionalMs(row.duration_p50_ms),
        duration_p95_ms: optionalMs(row.duration_p95_ms),
      })
    } else if (grp === 1) {
      agentSummaries.push({
        model: String(row.model),
        succeeded: Number(row.succeeded ?? 0),
        failed: Number(row.failed ?? 0),
        ttft_p50_ms: optionalMs(row.ttft_p50_ms),
        ttft_p95_ms: optionalMs(row.ttft_p95_ms),
        duration_p50_ms: optionalMs(row.duration_p50_ms),
        duration_p95_ms: optionalMs(row.duration_p95_ms),
      })
    } else if (grp === 3) {
      agentOverallTtftP50Ms = optionalMs(row.ttft_p50_ms)
    }
  }

  const apiBuckets: RawApiBucketRow[] = []
  let apiSummary = {
    requests: 0,
    server_errors: 0,
    p50_ms: null as number | null,
    p95_ms: null as number | null,
  }

  for (const row of apiRaw as unknown as Array<Record<string, unknown>>) {
    const grp = Number(row.grp)
    if (grp === 0) {
      apiBuckets.push({
        bucket_at: Math.round(Number(row.bucket_at)),
        requests: Number(row.requests ?? 0),
        server_errors: Number(row.server_errors ?? 0),
        p50_ms: optionalMs(row.p50_ms),
        p95_ms: optionalMs(row.p95_ms),
      })
    } else if (grp === 1) {
      apiSummary = {
        requests: Number(row.requests ?? 0),
        server_errors: Number(row.server_errors ?? 0),
        p50_ms: optionalMs(row.p50_ms),
        p95_ms: optionalMs(row.p95_ms),
      }
    }
  }

  return buildHealthMonitorSnapshot({
    range,
    includePolicy,
    now,
    generationBuckets,
    generationSummaries,
    generationOverallP50Ms,
    agentBuckets,
    agentSummaries,
    agentOverallTtftP50Ms,
    apiBuckets,
    apiSummary,
  })
}

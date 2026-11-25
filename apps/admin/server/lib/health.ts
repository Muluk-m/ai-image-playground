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

function optionalMs(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const num = Number(value)
  return Number.isFinite(num) && num >= 0 ? Math.round(num) : null
}

/** 从只读库并行读取生成任务、Agent 模型调用（含 TTFT）与核心接口健康数据。 */
export async function readHealthMonitor(
  range: HealthRange = DEFAULT_HEALTH_RANGE,
  includePolicy = false,
  now = Date.now(),
): Promise<HealthMonitorSnapshot> {
  const meta = HEALTH_RANGE_META[range]
  const bucketSeconds = meta.bucketSeconds
  const bucketMs = bucketSeconds * 1000
  const currentBucketStart = Math.floor(now / bucketMs) * bucketMs
  const windowStartSec = (currentBucketStart - (meta.bucketCount - 1) * bucketMs) / 1000
  const { db } = getDbHandle()

  const [
    genBucketsRaw,
    genSummaryRaw,
    genOverallRaw,
    agentBucketsRaw,
    agentSummaryRaw,
    agentOverallRaw,
    apiBucketsRaw,
    apiSummaryRaw,
  ] = await Promise.all([
    db.execute(sql`
      SELECT
        provider,
        model,
        gpt_route,
        EXTRACT(EPOCH FROM date_bin(make_interval(secs => ${bucketSeconds}), completed_at, TIMESTAMPTZ '2000-01-01')) * 1000 AS bucket_at,
        COUNT(*) FILTER (WHERE status = 'completed') AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed' AND error_type IS DISTINCT FROM 'content_policy') AS system_failed,
        COUNT(*) FILTER (WHERE status = 'failed' AND error_type = 'content_policy') AS policy_blocked,
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM completed_at - started_at) * 1000
        ) FILTER (WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at >= started_at) AS duration_p50_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM completed_at - started_at) * 1000
        ) FILTER (WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at >= started_at) AS duration_p95_ms,
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM started_at - submitted_at) * 1000
        ) FILTER (WHERE started_at IS NOT NULL AND started_at >= submitted_at) AS queue_wait_p50_ms
      FROM queue_tasks
      WHERE completed_at >= to_timestamp(${windowStartSec})
        AND status IN ('completed', 'failed')
      GROUP BY provider, model, gpt_route, 4
    `),
    db.execute(sql`
      SELECT
        provider,
        model,
        gpt_route,
        COUNT(*) FILTER (WHERE status = 'completed') AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed' AND error_type IS DISTINCT FROM 'content_policy') AS system_failed,
        COUNT(*) FILTER (WHERE status = 'failed' AND error_type = 'content_policy') AS policy_blocked,
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM completed_at - started_at) * 1000
        ) FILTER (WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at >= started_at) AS duration_p50_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM completed_at - started_at) * 1000
        ) FILTER (WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at >= started_at) AS duration_p95_ms,
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM started_at - submitted_at) * 1000
        ) FILTER (WHERE started_at IS NOT NULL AND started_at >= submitted_at) AS queue_wait_p50_ms
      FROM queue_tasks
      WHERE completed_at >= to_timestamp(${windowStartSec})
        AND status IN ('completed', 'failed')
      GROUP BY provider, model, gpt_route
    `),
    db.execute(sql`
      SELECT
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM completed_at - started_at) * 1000
        ) FILTER (WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at >= started_at) AS duration_p50_ms
      FROM queue_tasks
      WHERE completed_at >= to_timestamp(${windowStartSec})
        AND status = 'completed'
    `),
    db.execute(sql`
      SELECT
        model,
        EXTRACT(EPOCH FROM date_bin(make_interval(secs => ${bucketSeconds}), started_at, TIMESTAMPTZ '2000-01-01')) * 1000 AS bucket_at,
        COUNT(*) FILTER (WHERE status = 'completed') AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ttft_ms)
          FILTER (WHERE status = 'completed' AND ttft_ms IS NOT NULL) AS ttft_p50_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ttft_ms)
          FILTER (WHERE status = 'completed' AND ttft_ms IS NOT NULL) AS ttft_p95_ms,
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM finished_at - started_at) * 1000
        ) FILTER (WHERE status = 'completed' AND finished_at IS NOT NULL AND finished_at >= started_at) AS duration_p50_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM finished_at - started_at) * 1000
        ) FILTER (WHERE status = 'completed' AND finished_at IS NOT NULL AND finished_at >= started_at) AS duration_p95_ms
      FROM agent_model_calls
      WHERE started_at >= to_timestamp(${windowStartSec})
        AND purpose = 'conversation'
        AND status IN ('completed', 'failed')
        AND local_rejection IS NULL
      GROUP BY model, 2
    `),
    db.execute(sql`
      SELECT
        model,
        COUNT(*) FILTER (WHERE status = 'completed') AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ttft_ms)
          FILTER (WHERE status = 'completed' AND ttft_ms IS NOT NULL) AS ttft_p50_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ttft_ms)
          FILTER (WHERE status = 'completed' AND ttft_ms IS NOT NULL) AS ttft_p95_ms,
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM finished_at - started_at) * 1000
        ) FILTER (WHERE status = 'completed' AND finished_at IS NOT NULL AND finished_at >= started_at) AS duration_p50_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM finished_at - started_at) * 1000
        ) FILTER (WHERE status = 'completed' AND finished_at IS NOT NULL AND finished_at >= started_at) AS duration_p95_ms
      FROM agent_model_calls
      WHERE started_at >= to_timestamp(${windowStartSec})
        AND purpose = 'conversation'
        AND status IN ('completed', 'failed')
        AND local_rejection IS NULL
      GROUP BY model
    `),
    db.execute(sql`
      SELECT
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ttft_ms)
          FILTER (WHERE status = 'completed' AND ttft_ms IS NOT NULL) AS ttft_p50_ms
      FROM agent_model_calls
      WHERE started_at >= to_timestamp(${windowStartSec})
        AND purpose = 'conversation'
        AND status = 'completed'
        AND local_rejection IS NULL
    `),
    db.execute(sql`
      SELECT
        EXTRACT(EPOCH FROM date_bin(make_interval(secs => ${bucketSeconds}), minute, TIMESTAMPTZ '2000-01-01')) * 1000 AS bucket_at,
        COALESCE(SUM(requests), 0) AS requests,
        COALESCE(SUM(server_errors), 0) AS server_errors,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p50_ms) FILTER (WHERE p50_ms IS NOT NULL) AS p50_ms,
        MAX(p95_ms) AS p95_ms
      FROM api_minutes
      WHERE minute >= to_timestamp(${windowStartSec})
      GROUP BY 1
    `),
    db.execute(sql`
      SELECT
        COALESCE(SUM(requests), 0) AS requests,
        COALESCE(SUM(server_errors), 0) AS server_errors,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p50_ms) FILTER (WHERE p50_ms IS NOT NULL) AS p50_ms,
        MAX(p95_ms) AS p95_ms
      FROM api_minutes
      WHERE minute >= to_timestamp(${windowStartSec})
    `),
  ])

  const parseRoute = (value: unknown): TaskListItem['gpt_route'] =>
    value === 'direct' || value === 'sub2api' ? value : null

  const generationBuckets: RawGenerationBucketRow[] = (
    genBucketsRaw as unknown as Array<Record<string, unknown>>
  ).map((row) => ({
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
  }))

  const generationSummaries: RawGenerationSummaryRow[] = (
    genSummaryRaw as unknown as Array<Record<string, unknown>>
  ).map((row) => ({
    provider: String(row.provider),
    model: String(row.model),
    gpt_route: parseRoute(row.gpt_route),
    succeeded: Number(row.succeeded ?? 0),
    system_failed: Number(row.system_failed ?? 0),
    policy_blocked: Number(row.policy_blocked ?? 0),
    duration_p50_ms: optionalMs(row.duration_p50_ms),
    duration_p95_ms: optionalMs(row.duration_p95_ms),
    queue_wait_p50_ms: optionalMs(row.queue_wait_p50_ms),
  }))

  const genOverallRow = (genOverallRaw as unknown as Array<Record<string, unknown>>)[0] ?? {}

  const agentBuckets: RawAgentBucketRow[] = (
    agentBucketsRaw as unknown as Array<Record<string, unknown>>
  ).map((row) => ({
    model: String(row.model),
    bucket_at: Math.round(Number(row.bucket_at)),
    succeeded: Number(row.succeeded ?? 0),
    failed: Number(row.failed ?? 0),
    ttft_p50_ms: optionalMs(row.ttft_p50_ms),
    ttft_p95_ms: optionalMs(row.ttft_p95_ms),
    duration_p50_ms: optionalMs(row.duration_p50_ms),
    duration_p95_ms: optionalMs(row.duration_p95_ms),
  }))

  const agentSummaries: RawAgentSummaryRow[] = (
    agentSummaryRaw as unknown as Array<Record<string, unknown>>
  ).map((row) => ({
    model: String(row.model),
    succeeded: Number(row.succeeded ?? 0),
    failed: Number(row.failed ?? 0),
    ttft_p50_ms: optionalMs(row.ttft_p50_ms),
    ttft_p95_ms: optionalMs(row.ttft_p95_ms),
    duration_p50_ms: optionalMs(row.duration_p50_ms),
    duration_p95_ms: optionalMs(row.duration_p95_ms),
  }))

  const agentOverallRow = (agentOverallRaw as unknown as Array<Record<string, unknown>>)[0] ?? {}

  const apiBuckets: RawApiBucketRow[] = (
    apiBucketsRaw as unknown as Array<Record<string, unknown>>
  ).map((row) => ({
    bucket_at: Math.round(Number(row.bucket_at)),
    requests: Number(row.requests ?? 0),
    server_errors: Number(row.server_errors ?? 0),
    p50_ms: optionalMs(row.p50_ms),
    p95_ms: optionalMs(row.p95_ms),
  }))

  const apiSummaryRow = (apiSummaryRaw as unknown as Array<Record<string, unknown>>)[0] ?? {}

  return buildHealthMonitorSnapshot({
    range,
    includePolicy,
    now,
    generationBuckets,
    generationSummaries,
    generationOverallP50Ms: optionalMs(genOverallRow.duration_p50_ms),
    agentBuckets,
    agentSummaries,
    agentOverallTtftP50Ms: optionalMs(agentOverallRow.ttft_p50_ms),
    apiBuckets,
    apiSummary: {
      requests: Number(apiSummaryRow.requests ?? 0),
      server_errors: Number(apiSummaryRow.server_errors ?? 0),
      p50_ms: optionalMs(apiSummaryRow.p50_ms),
      p95_ms: optionalMs(apiSummaryRow.p95_ms),
    },
  })
}

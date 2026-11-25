import {
  gptRouteLabel,
  HEALTH_RANGE_META,
  type HealthBucket,
  type HealthComponent,
  type HealthComponentKind,
  type HealthGroup,
  type HealthMonitorSnapshot,
  type HealthRange,
  type HealthStatus,
  type TaskListItem,
} from '../../contracts'

/** 状态严重度排序：用于汇总组件到分组、分组到全局。 */
const STATUS_SEVERITY: Record<HealthStatus, number> = {
  idle: 0,
  healthy: 1,
  degraded: 2,
  outage: 3,
}

/** 当前实时状态回看最近几个时间桶（3 格：6h=15m / 24h=45m / 7d=6h）。 */
const RECENT_ACTIVE_LOOKBACK = 3

/** 单桶降级/异常判定阈值。 */
export const HEALTH_THRESHOLDS = {
  OUTAGE_SUCCESS_RATE: 0.8,
  DEGRADED_SUCCESS_RATE: 0.98,
  AGENT_TTFT_DEGRADED_MS: 10_000,
  GENERATION_QUEUE_WAIT_DEGRADED_MS: 60_000,
  API_P95_DEGRADED_MS: 3_000,
} as const

export interface BucketMetricsInput {
  readonly total: number
  readonly succeeded: number
  readonly ttft_p50_ms?: number | null
  readonly queue_wait_p50_ms?: number | null
  readonly duration_p95_ms?: number | null
}

/** 根据单桶成功率和关键延迟指标判定状态。 */
export function classifyBucketStatus(
  kind: HealthComponentKind,
  input: BucketMetricsInput,
): HealthStatus {
  if (input.total <= 0) return 'idle'
  const rate = input.succeeded / input.total
  if (rate < HEALTH_THRESHOLDS.OUTAGE_SUCCESS_RATE) return 'outage'
  if (rate < HEALTH_THRESHOLDS.DEGRADED_SUCCESS_RATE) return 'degraded'
  if (
    kind === 'agent' &&
    input.ttft_p50_ms != null &&
    input.ttft_p50_ms > HEALTH_THRESHOLDS.AGENT_TTFT_DEGRADED_MS
  ) {
    return 'degraded'
  }
  if (
    kind === 'generation' &&
    input.queue_wait_p50_ms != null &&
    input.queue_wait_p50_ms > HEALTH_THRESHOLDS.GENERATION_QUEUE_WAIT_DEGRADED_MS
  ) {
    return 'degraded'
  }
  if (
    kind === 'api' &&
    input.duration_p95_ms != null &&
    input.duration_p95_ms > HEALTH_THRESHOLDS.API_P95_DEGRADED_MS
  ) {
    return 'degraded'
  }
  return 'healthy'
}

/** 取最近几个桶中最新一个有流量的状态作为当前状态；近期无流量则记为 idle。 */
export function deriveCurrentStatus(buckets: readonly HealthBucket[]): HealthStatus {
  const start = Math.max(0, buckets.length - RECENT_ACTIVE_LOOKBACK)
  for (let i = buckets.length - 1; i >= start; i -= 1) {
    const bucket = buckets[i]
    if (bucket && bucket.status !== 'idle') return bucket.status
  }
  return 'idle'
}

export function worstStatus(statuses: readonly HealthStatus[]): HealthStatus {
  let worst: HealthStatus = 'idle'
  for (const status of statuses) {
    if (STATUS_SEVERITY[status] > STATUS_SEVERITY[worst]) worst = status
  }
  return worst
}

function providerGroupTitle(provider: string): string {
  if (provider === 'openai-compat') return 'OpenAI 兼容生成'
  if (provider === 'gemini') return 'Gemini 生成'
  return `${provider} 生成`
}

export interface RawGenerationBucketRow {
  readonly provider: string
  readonly model: string
  readonly gpt_route: TaskListItem['gpt_route']
  readonly bucket_at: number
  readonly succeeded: number
  readonly system_failed: number
  readonly policy_blocked: number
  readonly duration_p50_ms: number | null
  readonly duration_p95_ms: number | null
  readonly queue_wait_p50_ms: number | null
}

export interface RawGenerationSummaryRow {
  readonly provider: string
  readonly model: string
  readonly gpt_route: TaskListItem['gpt_route']
  readonly succeeded: number
  readonly system_failed: number
  readonly policy_blocked: number
  readonly duration_p50_ms: number | null
  readonly duration_p95_ms: number | null
  readonly queue_wait_p50_ms: number | null
}

export interface RawAgentBucketRow {
  readonly model: string
  readonly bucket_at: number
  readonly succeeded: number
  readonly failed: number
  readonly ttft_p50_ms: number | null
  readonly ttft_p95_ms: number | null
  readonly duration_p50_ms: number | null
  readonly duration_p95_ms: number | null
}

export interface RawAgentSummaryRow {
  readonly model: string
  readonly succeeded: number
  readonly failed: number
  readonly ttft_p50_ms: number | null
  readonly ttft_p95_ms: number | null
  readonly duration_p50_ms: number | null
  readonly duration_p95_ms: number | null
}

export interface RawApiBucketRow {
  readonly bucket_at: number
  readonly requests: number
  readonly server_errors: number
  readonly p50_ms: number | null
  readonly p95_ms: number | null
}

export interface RawApiSummaryRow {
  readonly requests: number
  readonly server_errors: number
  readonly p50_ms: number | null
  readonly p95_ms: number | null
}

export interface HealthRawInput {
  readonly range: HealthRange
  readonly includePolicy: boolean
  readonly now: number
  readonly generationBuckets: readonly RawGenerationBucketRow[]
  readonly generationSummaries: readonly RawGenerationSummaryRow[]
  readonly generationOverallP50Ms: number | null
  readonly agentBuckets: readonly RawAgentBucketRow[]
  readonly agentSummaries: readonly RawAgentSummaryRow[]
  readonly agentOverallTtftP50Ms: number | null
  readonly apiBuckets: readonly RawApiBucketRow[]
  readonly apiSummary: RawApiSummaryRow
}

/** 对齐时间窗口并把三路聚合结果组装为连续、固定桶数的健康监测快照。 */
export function buildHealthMonitorSnapshot(input: HealthRawInput): HealthMonitorSnapshot {
  const meta = HEALTH_RANGE_META[input.range]
  const bucketMs = meta.bucketSeconds * 1000
  const bucketCount = meta.bucketCount
  const currentBucketStart = Math.floor(input.now / bucketMs) * bucketMs
  const windowStartAt = currentBucketStart - (bucketCount - 1) * bucketMs
  const windowEndAt = currentBucketStart + bucketMs

  const buildEmptyBuckets = (): HealthBucket[] =>
    Array.from({ length: bucketCount }, (_, i) => ({
      start_at: windowStartAt + i * bucketMs,
      end_at: windowStartAt + (i + 1) * bucketMs,
      status: 'idle' as const,
      total: 0,
      succeeded: 0,
      failed: 0,
      success_rate: null,
    }))

  const slotIndex = (bucketAt: number): number => Math.round((bucketAt - windowStartAt) / bucketMs)

  // 1. 生成任务：按 provider 分组，内部按 (model, gpt_route) 拆分组件
  const genBucketMap = new Map<string, Map<number, RawGenerationBucketRow>>()
  for (const row of input.generationBuckets) {
    const key = `${row.provider}::${row.model}::${row.gpt_route ?? ''}`
    let bySlot = genBucketMap.get(key)
    if (!bySlot) {
      bySlot = new Map()
      genBucketMap.set(key, bySlot)
    }
    const idx = slotIndex(row.bucket_at)
    if (idx >= 0 && idx < bucketCount) bySlot.set(idx, row)
  }

  const genByProvider = new Map<string, HealthComponent[]>()
  let genTotal = 0
  let genSucceeded = 0

  for (const summary of input.generationSummaries) {
    const key = `${summary.provider}::${summary.model}::${summary.gpt_route ?? ''}`
    const bySlot = genBucketMap.get(key)
    const buckets = buildEmptyBuckets()
    if (bySlot) {
      for (const [idx, row] of bySlot.entries()) {
        const failed = input.includePolicy
          ? row.system_failed + row.policy_blocked
          : row.system_failed
        const total = row.succeeded + failed
        const startAt = windowStartAt + idx * bucketMs
        buckets[idx] = {
          start_at: startAt,
          end_at: startAt + bucketMs,
          status: classifyBucketStatus('generation', {
            total,
            succeeded: row.succeeded,
            queue_wait_p50_ms: row.queue_wait_p50_ms,
          }),
          total,
          succeeded: row.succeeded,
          failed,
          success_rate: total > 0 ? row.succeeded / total : null,
          ...(row.policy_blocked > 0 ? { policy_blocked: row.policy_blocked } : {}),
          duration_p50_ms: row.duration_p50_ms,
          duration_p95_ms: row.duration_p95_ms,
          queue_wait_p50_ms: row.queue_wait_p50_ms,
        }
      }
    }

    const failed = input.includePolicy
      ? summary.system_failed + summary.policy_blocked
      : summary.system_failed
    const total = summary.succeeded + failed
    genTotal += total
    genSucceeded += summary.succeeded

    const badge = gptRouteLabel(summary.gpt_route)
    const component: HealthComponent = {
      id: `gen:${key}`,
      kind: 'generation',
      name: summary.model,
      ...(badge ? { badge } : {}),
      status: deriveCurrentStatus(buckets),
      availability: total > 0 ? summary.succeeded / total : null,
      total,
      succeeded: summary.succeeded,
      failed,
      ...(summary.policy_blocked > 0 ? { policy_blocked: summary.policy_blocked } : {}),
      duration_p50_ms: summary.duration_p50_ms,
      duration_p95_ms: summary.duration_p95_ms,
      queue_wait_p50_ms: summary.queue_wait_p50_ms,
      buckets,
    }
    const list = genByProvider.get(summary.provider) ?? []
    list.push(component)
    genByProvider.set(summary.provider, list)
  }

  const generationGroups: HealthGroup[] = [...genByProvider.entries()]
    .map(([provider, components]) => {
      const sorted = [...components].sort(
        (a, b) => b.total - a.total || a.name.localeCompare(b.name),
      )
      const total = sorted.reduce((acc, item) => acc + item.total, 0)
      const succeeded = sorted.reduce((acc, item) => acc + item.succeeded, 0)
      const failed = sorted.reduce((acc, item) => acc + item.failed, 0)
      return {
        id: `generation:${provider}`,
        kind: 'generation' as const,
        name: providerGroupTitle(provider),
        status: worstStatus(sorted.map((item) => item.status)),
        availability: total > 0 ? succeeded / total : null,
        total,
        succeeded,
        failed,
        components: sorted,
      }
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))

  // 2. Agent 对话模型：按 model 分组件，突出 TTFT 中位数/P95 与总耗时
  const agentBucketMap = new Map<string, Map<number, RawAgentBucketRow>>()
  for (const row of input.agentBuckets) {
    let bySlot = agentBucketMap.get(row.model)
    if (!bySlot) {
      bySlot = new Map()
      agentBucketMap.set(row.model, bySlot)
    }
    const idx = slotIndex(row.bucket_at)
    if (idx >= 0 && idx < bucketCount) bySlot.set(idx, row)
  }

  const agentComponents: HealthComponent[] = input.agentSummaries
    .map((summary) => {
      const bySlot = agentBucketMap.get(summary.model)
      const buckets = buildEmptyBuckets()
      if (bySlot) {
        for (const [idx, row] of bySlot.entries()) {
          const total = row.succeeded + row.failed
          const startAt = windowStartAt + idx * bucketMs
          buckets[idx] = {
            start_at: startAt,
            end_at: startAt + bucketMs,
            status: classifyBucketStatus('agent', {
              total,
              succeeded: row.succeeded,
              ttft_p50_ms: row.ttft_p50_ms,
            }),
            total,
            succeeded: row.succeeded,
            failed: row.failed,
            success_rate: total > 0 ? row.succeeded / total : null,
            ttft_p50_ms: row.ttft_p50_ms,
            ttft_p95_ms: row.ttft_p95_ms,
            duration_p50_ms: row.duration_p50_ms,
            duration_p95_ms: row.duration_p95_ms,
          }
        }
      }
      const total = summary.succeeded + summary.failed
      return {
        id: `agent:${summary.model}`,
        kind: 'agent' as const,
        name: summary.model,
        badge: 'Agent',
        status: deriveCurrentStatus(buckets),
        availability: total > 0 ? summary.succeeded / total : null,
        total,
        succeeded: summary.succeeded,
        failed: summary.failed,
        ttft_p50_ms: summary.ttft_p50_ms,
        ttft_p95_ms: summary.ttft_p95_ms,
        duration_p50_ms: summary.duration_p50_ms,
        duration_p95_ms: summary.duration_p95_ms,
        buckets,
      }
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))

  const agentTotal = agentComponents.reduce((acc, item) => acc + item.total, 0)
  const agentSucceeded = agentComponents.reduce((acc, item) => acc + item.succeeded, 0)
  const agentFailed = agentComponents.reduce((acc, item) => acc + item.failed, 0)

  const agentGroup: HealthGroup = {
    id: 'agent:models',
    kind: 'agent',
    name: 'Agent 对话模型',
    status: worstStatus(agentComponents.map((item) => item.status)),
    availability: agentTotal > 0 ? agentSucceeded / agentTotal : null,
    total: agentTotal,
    succeeded: agentSucceeded,
    failed: agentFailed,
    components: agentComponents,
  }

  // 3. 后端核心接口（api_minutes）
  const apiBuckets = buildEmptyBuckets()
  for (const row of input.apiBuckets) {
    const idx = slotIndex(row.bucket_at)
    if (idx < 0 || idx >= bucketCount) continue
    const succeeded = Math.max(0, row.requests - row.server_errors)
    const startAt = windowStartAt + idx * bucketMs
    apiBuckets[idx] = {
      start_at: startAt,
      end_at: startAt + bucketMs,
      status: classifyBucketStatus('api', {
        total: row.requests,
        succeeded,
        duration_p95_ms: row.p95_ms,
      }),
      total: row.requests,
      succeeded,
      failed: row.server_errors,
      success_rate: row.requests > 0 ? succeeded / row.requests : null,
      duration_p50_ms: row.p50_ms,
      duration_p95_ms: row.p95_ms,
    }
  }

  const apiTotal = input.apiSummary.requests
  const apiFailed = input.apiSummary.server_errors
  const apiSucceeded = Math.max(0, apiTotal - apiFailed)
  const apiComponent: HealthComponent = {
    id: 'api:core',
    kind: 'api',
    name: 'BFF 核心接口',
    badge: 'API',
    status: deriveCurrentStatus(apiBuckets),
    availability: apiTotal > 0 ? apiSucceeded / apiTotal : null,
    total: apiTotal,
    succeeded: apiSucceeded,
    failed: apiFailed,
    duration_p50_ms: input.apiSummary.p50_ms,
    duration_p95_ms: input.apiSummary.p95_ms,
    buckets: apiBuckets,
  }

  const apiGroup: HealthGroup = {
    id: 'api:core',
    kind: 'api',
    name: '后端核心接口',
    status: apiComponent.status,
    availability: apiComponent.availability,
    total: apiTotal,
    succeeded: apiSucceeded,
    failed: apiFailed,
    components: [apiComponent],
  }

  const resolvedGenGroups: HealthGroup[] =
    generationGroups.length > 0
      ? generationGroups
      : [
          {
            id: 'generation:empty',
            kind: 'generation',
            name: '图像 / 视频生成',
            status: 'idle',
            availability: null,
            total: 0,
            succeeded: 0,
            failed: 0,
            components: [],
          },
        ]
  const groups: HealthGroup[] = [...resolvedGenGroups, agentGroup, apiGroup]

  const genAvailability = genTotal > 0 ? genSucceeded / genTotal : null
  const agentAvailability = agentTotal > 0 ? agentSucceeded / agentTotal : null
  const apiAvailability = apiTotal > 0 ? apiSucceeded / apiTotal : null
  // 综合可用率按各活跃维度取最低值（与 worstStatus 同口径），避免高频接口轮询稀释业务生成/Agent 故障。
  const activeAvailabilities = [genAvailability, agentAvailability, apiAvailability].filter(
    (v): v is number => v !== null,
  )
  const overallAvailability =
    activeAvailabilities.length > 0 ? Math.min(...activeAvailabilities) : null

  return {
    generated_at: input.now,
    range: input.range,
    include_policy: input.includePolicy,
    bucket_ms: bucketMs,
    bucket_count: bucketCount,
    window_start_at: windowStartAt,
    window_end_at: windowEndAt,
    summary: {
      status: worstStatus(groups.map((g) => g.status)),
      availability: overallAvailability,
      generation_total: genTotal,
      generation_availability: genAvailability,
      generation_p50_ms: input.generationOverallP50Ms,
      agent_total: agentTotal,
      agent_availability: agentAvailability,
      agent_ttft_p50_ms: input.agentOverallTtftP50Ms,
      api_total: apiTotal,
      api_availability: apiAvailability,
      api_p95_ms: input.apiSummary.p95_ms,
    },
    groups,
  }
}

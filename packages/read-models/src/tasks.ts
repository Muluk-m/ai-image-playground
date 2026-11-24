import type { TaskStatus } from '@image-playground/shared'
import { and, asc, eq, getViewSelectedFields, sql } from 'drizzle-orm'
import {
  extractTaskImagesMeta,
  extractTaskPrompt,
  ilikeContains,
  mapGenerationTask,
  PROMPT_TEXT_SQL,
  parsePercentilePair,
  type ReadModelsDb,
  type ReadModelsDbHandle,
  type Row,
  sqlTextIn,
  TASK_SELECT_SQL,
  taskSourceSql,
} from './sql-helpers'
import {
  redactTaskErrorMessage,
  redactTaskRequestPayload,
  redactUpstreamBody,
} from './task-redaction'
import {
  type GenerationTaskFilters,
  type GenerationTaskItem,
  type GenerationTasksFacetOption,
  type GenerationTasksFacets,
  type GenerationTasksResult,
  type GenerationTasksSummary,
  type TaskDetail,
  type TaskListItem,
  type TimeWindow,
  todayWindow,
} from './types'

export class TaskQueryError extends Error {}

const CURSOR_PAGE_SIZE = 100
const EXPORT_CAP = 10_000

/** Independent analysis facts outlive transient worker rows and never expose image archives. */
async function getAnalysisTask(
  handle: ReadModelsDbHandle,
  taskId: string,
): Promise<TaskDetail | null> {
  const { db, schema } = handle
  const [row] = await db
    .select({ analysis: schema.analysis_tasks, call: schema.analysis_model_calls })
    .from(schema.analysis_tasks)
    .leftJoin(
      schema.analysis_model_calls,
      eq(schema.analysis_model_calls.task_id, schema.analysis_tasks.task_id),
    )
    .where(eq(schema.analysis_tasks.task_id, taskId))
    .limit(1)
  if (!row) return null
  const { analysis, call } = row
  return {
    id: analysis.task_id,
    kind: 'analysis',
    source: analysis.origin_conversation_id !== null ? 'chat' : 'manual',
    provider: 'openai-compat',
    model: analysis.model,
    status: analysis.status,
    submitted_at: analysis.created_at,
    started_at: call?.dispatched_at ?? null,
    completed_at: analysis.completed_at,
    error_type: analysis.error_code,
    upstream_status: null,
    gpt_route: null,
    gpt_key_fingerprint: null,
    prompt: analysis.input_snapshot.prompt,
    request_payload: { prompt: analysis.input_snapshot.prompt },
    upstream_invocation_count: call?.http_dispatch_count ?? 0,
    attempt_count: analysis.attempt,
    result_meta: { images: [] },
    error_message: analysis.error_code,
    upstream_body: null,
    device_id: analysis.device_id,
    user_id: analysis.user_id,
    next_retry_at: null,
    analysis: {
      pricing: analysis.price_snapshot,
      reservedCredits: analysis.reserved_credits,
      actualCredits: analysis.actual_credits,
      findings: analysis.findings,
      coverage: analysis.coverage,
      evidence: analysis.evidence,
      usage: call?.usage ?? null,
      upstreamRequestId: call?.upstream_request_id ?? null,
      localRejection: call?.local_rejection ?? null,
    },
  }
}

export async function getTask(
  handle: ReadModelsDbHandle,
  taskId: string,
): Promise<TaskDetail | null> {
  const { db, schema } = handle
  const rows = await db
    .select({
      ...getViewSelectedFields(schema.queue_tasks),
      source: taskSourceSql(schema.queue_tasks.id, schema.queue_tasks.agent_conversation_id),
    })
    .from(schema.queue_tasks)
    .where(eq(schema.queue_tasks.id, taskId))
    .limit(1)
  const task = rows[0]
  if (!task) return getAnalysisTask(handle, taskId)
  const drafts =
    task.agent_conversation_id === null
      ? []
      : await db
          .select({ created_at: schema.agent_generation_drafts.created_at })
          .from(schema.agent_generation_drafts)
          .where(
            and(
              eq(schema.agent_generation_drafts.task_id, taskId),
              eq(schema.agent_generation_drafts.conversation_id, task.agent_conversation_id),
            ),
          )
          .orderBy(asc(schema.agent_generation_drafts.created_at))
          .limit(1)

  const images = extractTaskImagesMeta(task.provider, task.result_payload)

  const { result_payload: _result_payload, ...rest } = task as unknown as Row
  void _result_payload
  const request_payload = rest.request_payload
  const rawDevice = task.device_id
  const device_id =
    rawDevice === null || rawDevice === undefined || rawDevice === '' ? null : String(rawDevice)
  return {
    ...(rest as unknown as Omit<TaskListItem, 'prompt' | 'upstream_invocation_count'>),
    source: task.source,
    ...(task.agent_conversation_id !== null
      ? {
          prompt_created_at: drafts[0]?.created_at ?? task.submitted_at,
        }
      : {}),
    prompt: extractTaskPrompt(request_payload),
    upstream_invocation_count: Number(task.upstream_invocation_count),
    request_payload: redactTaskRequestPayload(request_payload),
    user_id: task.user_id,
    result_meta: { images },
    error_message: redactTaskErrorMessage(task.error_message),
    upstream_status: task.upstream_status,
    upstream_body: redactUpstreamBody(task.upstream_body),
    device_id,
    next_retry_at: task.next_retry_at,
  }
}

function taskWindow(filters: GenerationTaskFilters): TimeWindow {
  return filters.from !== undefined && filters.to !== undefined
    ? { from: filters.from, to: filters.to }
    : todayWindow()
}

function mergedStatuses(filters: GenerationTaskFilters): TaskStatus[] {
  return [...new Set([...(filters.status ? [filters.status] : []), ...(filters.statuses ?? [])])]
}

function mergedSources(filters: GenerationTaskFilters): string[] {
  return [...new Set([...(filters.source ? [filters.source] : []), ...(filters.sources ?? [])])]
}

function taskConditions(
  filters: GenerationTaskFilters,
  window: TimeWindow,
  options: { cursor?: string; ignoreStatus?: boolean } = {},
) {
  const conditions = [
    sql`t.submitted_at >= ${new Date(window.from)} AND t.submitted_at <= ${new Date(window.to)}`,
  ]
  if (filters.userId) conditions.push(sql`t.user_id = ${filters.userId}`)
  if (filters.deviceId)
    conditions.push(sql`t.user_id IS NULL AND t.device_id = ${filters.deviceId}`)
  if (filters.unassigned) conditions.push(sql`t.user_id IS NULL AND t.device_id IS NULL`)
  if (filters.actorType === 'user') conditions.push(sql`t.user_id IS NOT NULL`)
  else if (filters.actorType === 'device')
    conditions.push(sql`t.user_id IS NULL AND t.device_id IS NOT NULL`)
  else if (filters.actorType === 'unassigned')
    conditions.push(sql`t.user_id IS NULL AND t.device_id IS NULL`)

  if (!options.ignoreStatus) {
    const statuses = mergedStatuses(filters)
    if (statuses.length === 1) conditions.push(sql`t.status = ${statuses[0]}`)
    else if (statuses.length > 1) conditions.push(sqlTextIn(sql`t.status`, statuses))
  }

  const sources = mergedSources(filters)
  const sourceExpr = taskSourceSql(sql`t.id`, sql`t.agent_conversation_id`)
  if (sources.length === 1) conditions.push(sql`${sourceExpr} = ${sources[0]}`)
  else if (sources.length > 1) conditions.push(sqlTextIn(sourceExpr, sources))

  const models = [
    ...new Set([...(filters.model ? [filters.model] : []), ...(filters.models ?? [])]),
  ]
  if (models.length === 1) conditions.push(sql`t.model = ${models[0]}`)
  else if (models.length > 1) conditions.push(sqlTextIn(sql`t.model`, models))

  if (filters.providers?.length === 1) conditions.push(sql`t.provider = ${filters.providers[0]}`)
  else if (filters.providers && filters.providers.length > 1)
    conditions.push(sqlTextIn(sql`t.provider`, filters.providers))

  if (filters.gptRoute === 'direct') conditions.push(sql`t.gpt_route = 'direct'`)
  else if (filters.gptRoute === 'sub2api') conditions.push(sql`t.gpt_route = 'sub2api'`)
  else if (filters.gptRoute === 'none') conditions.push(sql`t.gpt_route IS NULL`)

  if (filters.errorTypes?.length) {
    const known = filters.errorTypes.filter((value) => value !== 'unknown')
    const unknown = filters.errorTypes.includes('unknown')
    const parts = []
    if (known.length === 1) parts.push(sql`t.error_type = ${known[0]}`)
    else if (known.length > 1) parts.push(sqlTextIn(sql`t.error_type`, known))
    if (unknown)
      parts.push(
        sql`(t.error_type = 'unknown' OR (t.error_type IS NULL AND t.status IN ('failed', 'reconciling')))`,
      )
    if (parts.length === 1) conditions.push(parts[0]!)
    else if (parts.length > 1) conditions.push(sql`(${sql.join(parts, sql` OR `)})`)
  }

  if (filters.httpBuckets?.length) {
    const parts = filters.httpBuckets.map((bucket) => {
      if (bucket === '2xx') return sql`(t.upstream_status >= 200 AND t.upstream_status < 300)`
      if (bucket === '4xx') return sql`(t.upstream_status >= 400 AND t.upstream_status < 500)`
      if (bucket === '429') return sql`t.upstream_status = 429`
      if (bucket === '5xx') return sql`(t.upstream_status >= 500 AND t.upstream_status < 600)`
      return sql`t.upstream_status IS NULL`
    })
    if (parts.length === 1) conditions.push(parts[0]!)
    else conditions.push(sql`(${sql.join(parts, sql` OR `)})`)
  }

  if (filters.minDurationSec !== undefined)
    conditions.push(
      sql`t.started_at IS NOT NULL AND t.completed_at IS NOT NULL AND t.completed_at >= t.started_at AND EXTRACT(EPOCH FROM (t.completed_at - t.started_at)) >= ${filters.minDurationSec}`,
    )
  if (filters.maxDurationSec !== undefined)
    conditions.push(
      sql`t.started_at IS NOT NULL AND t.completed_at IS NOT NULL AND t.completed_at >= t.started_at AND EXTRACT(EPOCH FROM (t.completed_at - t.started_at)) <= ${filters.maxDurationSec}`,
    )
  if (filters.retried === '1') conditions.push(sql`t.attempt_count > 1`)
  if (filters.minQueueSec !== undefined)
    conditions.push(
      sql`t.started_at IS NOT NULL AND t.started_at >= t.submitted_at AND EXTRACT(EPOCH FROM (t.started_at - t.submitted_at)) >= ${filters.minQueueSec}`,
    )

  if (filters.q) {
    const pattern = ilikeContains(filters.q)
    conditions.push(
      sql`(t.id = ${filters.q} OR t.id ILIKE ${pattern} ESCAPE '\\' OR t.device_id = ${filters.q} OR t.gpt_key_fingerprint = ${filters.q} OR t.model ILIKE ${pattern} ESCAPE '\\' OR u.username ILIKE ${pattern} ESCAPE '\\' OR ${PROMPT_TEXT_SQL} ILIKE ${pattern} ESCAPE '\\')`,
    )
  }
  if (options.cursor) {
    const separator = options.cursor.indexOf('_')
    const at = Number(options.cursor.slice(0, separator))
    const id = options.cursor.slice(separator + 1)
    if (
      separator < 1 ||
      !Number.isSafeInteger(at) ||
      at < window.from ||
      at > window.to ||
      !id ||
      id.length > 128
    )
      throw new TaskQueryError('无效的任务游标')
    conditions.push(sql`(t.submitted_at, t.id) < (${new Date(at)}, ${id})`)
  }
  return conditions
}

function taskOrderBy(filters: GenerationTaskFilters) {
  const sort = filters.sort ?? 'submitted_at'
  const dir = filters.dir ?? (sort === 'status' ? 'asc' : 'desc')
  const direction = dir === 'asc' ? sql`ASC` : sql`DESC`
  switch (sort) {
    case 'run_ms':
      return sql`CASE WHEN t.started_at IS NOT NULL AND t.completed_at IS NOT NULL AND t.completed_at >= t.started_at THEN EXTRACT(EPOCH FROM (t.completed_at - t.started_at)) WHEN t.completed_at IS NULL AND t.started_at IS NOT NULL AND t.status IN ('in_progress', 'reconciling') THEN GREATEST(0, EXTRACT(EPOCH FROM (NOW() - t.started_at))) END ${direction} NULLS LAST, t.submitted_at DESC, t.id DESC`
    case 'queue_ms':
      return sql`CASE WHEN t.started_at IS NOT NULL AND t.started_at >= t.submitted_at THEN EXTRACT(EPOCH FROM (t.started_at - t.submitted_at)) WHEN t.started_at IS NULL AND t.status = 'queued' THEN GREATEST(0, EXTRACT(EPOCH FROM (NOW() - t.submitted_at))) END ${direction} NULLS LAST, t.submitted_at DESC, t.id DESC`
    case 'total_ms':
      return sql`CASE WHEN t.completed_at IS NOT NULL AND t.completed_at >= t.submitted_at THEN EXTRACT(EPOCH FROM (t.completed_at - t.submitted_at)) WHEN t.completed_at IS NULL AND t.status IN ('queued', 'in_progress', 'reconciling') THEN GREATEST(0, EXTRACT(EPOCH FROM (NOW() - t.submitted_at))) END ${direction} NULLS LAST, t.submitted_at DESC, t.id DESC`
    case 'attempt_count':
      return sql`t.attempt_count ${direction}, t.upstream_invocation_count ${direction}, t.submitted_at DESC, t.id DESC`
    case 'upstream_invocation_count':
      return sql`t.upstream_invocation_count ${direction}, t.attempt_count ${direction}, t.submitted_at DESC, t.id DESC`
    case 'upstream_status':
      return sql`t.upstream_status ${direction} NULLS LAST, t.submitted_at DESC, t.id DESC`
    case 'status':
      return sql`CASE t.status WHEN 'in_progress' THEN 1 WHEN 'reconciling' THEN 2 WHEN 'queued' THEN 3 WHEN 'failed' THEN 4 WHEN 'completed' THEN 5 WHEN 'cancelled' THEN 6 ELSE 7 END ${direction}, t.submitted_at DESC, t.id DESC`
    default:
      return sql`t.submitted_at ${direction}, t.id ${direction}`
  }
}

function emptyStatusCounts(): Record<TaskStatus, number> {
  return {
    queued: 0,
    in_progress: 0,
    reconciling: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  }
}

function sortFacetOptions(items: GenerationTasksFacetOption[]): GenerationTasksFacetOption[] {
  return items.sort((a, b) =>
    b.count !== a.count ? b.count - a.count : a.value.localeCompare(b.value),
  )
}

// 精确时间窗分面短缓存 + 并发合并：翻页、改筛选和改排序时复用下拉选项计数，不同时间窗绝不串数据。
// 按底层 `handle.db` 引用判等，兼容内联传入 `{ db, schema }` 的调用方。
const TASK_FACETS_CACHE_MS = 60_000
type WindowFacetOptions = Pick<GenerationTasksFacets, 'models' | 'providers' | 'errorTypes'>
const windowFacetsCache = new Map<
  string,
  { at: number; db: ReadModelsDb; value: WindowFacetOptions }
>()
const windowFacetsPending = new Map<
  string,
  { db: ReadModelsDb; promise: Promise<WindowFacetOptions> }
>()

export function resetWindowFacetsCacheForTesting(): void {
  windowFacetsCache.clear()
  windowFacetsPending.clear()
}

async function getWindowFacetOptions(
  handle: ReadModelsDbHandle,
  window: TimeWindow,
): Promise<WindowFacetOptions> {
  const db = handle.db
  const key = `${window.from}:${window.to}`
  const now = Date.now()
  const cached = windowFacetsCache.get(key)
  if (cached && cached.db === db && now - cached.at < TASK_FACETS_CACHE_MS) {
    return cached.value
  }
  const pending = windowFacetsPending.get(key)
  if (pending && pending.db === db) {
    return pending.promise
  }
  const promise = (async () => {
    const facetRows = (await db.execute(sql`
      SELECT
        GROUPING(f.model) AS g_model,
        GROUPING(f.provider) AS g_provider,
        GROUPING(f.err_key) AS g_err,
        f.model,
        f.provider,
        f.err_key,
        COUNT(*)::int AS count
      FROM (
        SELECT
          model,
          provider,
          CASE
            WHEN error_type IS NOT NULL THEN error_type
            WHEN status IN ('failed', 'reconciling') THEN 'unknown'
            ELSE NULL
          END AS err_key
        FROM queue_tasks
        WHERE submitted_at >= ${new Date(window.from)} AND submitted_at <= ${new Date(window.to)}
      ) f
      GROUP BY GROUPING SETS ((f.model), (f.provider), (f.err_key))
    `)) as unknown as Row[]

    const modelOptions: GenerationTasksFacetOption[] = []
    const providerOptions: GenerationTasksFacetOption[] = []
    const errorOptions: GenerationTasksFacetOption[] = []
    for (const row of facetRows) {
      const count = Number(row.count ?? 0)
      if (Number(row.g_model) === 0 && row.model != null)
        modelOptions.push({ value: String(row.model), count })
      else if (Number(row.g_provider) === 0 && row.provider != null)
        providerOptions.push({ value: String(row.provider), count })
      else if (Number(row.g_err) === 0 && row.err_key != null)
        errorOptions.push({ value: String(row.err_key), count })
    }
    const value: WindowFacetOptions = {
      models: sortFacetOptions(modelOptions),
      providers: sortFacetOptions(providerOptions),
      errorTypes: sortFacetOptions(errorOptions),
    }
    if (windowFacetsCache.size > 32) windowFacetsCache.clear()
    windowFacetsCache.set(key, { at: Date.now(), db, value })
    return value
  })()
  windowFacetsPending.set(key, { db, promise })
  try {
    return await promise
  } finally {
    if (windowFacetsPending.get(key)?.promise === promise) windowFacetsPending.delete(key)
  }
}

async function queryTaskSummarySnapshot(
  handle: ReadModelsDbHandle,
  filters: GenerationTaskFilters,
  window: TimeWindow,
  where: ReturnType<typeof sql>,
): Promise<{ summary: GenerationTasksSummary; statusCounts: Record<TaskStatus, number> }> {
  const { db } = handle
  const hasStatusFilter = mergedStatuses(filters).length > 0
  const statusWhere = hasStatusFilter
    ? sql.join(taskConditions(filters, window, { ignoreStatus: true }), sql` AND `)
    : null
  const [summaryRows, statusRows] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE t.status = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE t.status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE t.status = 'in_progress')::int AS in_progress,
        COUNT(*) FILTER (WHERE t.status = 'queued')::int AS queued,
        COUNT(*) FILTER (WHERE t.status = 'reconciling')::int AS reconciling,
        COUNT(*) FILTER (WHERE t.status = 'cancelled')::int AS cancelled,
        PERCENTILE_CONT(ARRAY[0.5, 0.95]) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (t.completed_at - t.started_at)) * 1000
        ) FILTER (
          WHERE t.status = 'completed'
            AND t.started_at IS NOT NULL
            AND t.completed_at IS NOT NULL
            AND t.completed_at >= t.started_at
        ) AS run_percentiles
      FROM queue_tasks t LEFT JOIN users u ON u.id = t.user_id
      WHERE ${where}
    `) as Promise<unknown> as Promise<Row[]>,
    statusWhere
      ? (db.execute(sql`
          SELECT t.status, COUNT(*)::int AS count
          FROM queue_tasks t LEFT JOIN users u ON u.id = t.user_id
          WHERE ${statusWhere}
          GROUP BY t.status
        `) as Promise<unknown> as Promise<Row[]>)
      : Promise.resolve(null),
  ])

  const summaryRow = summaryRows[0] ?? {}
  const total = Number(summaryRow.total ?? 0)
  const [p50RunMs, p95RunMs] = parsePercentilePair(summaryRow.run_percentiles)
  const summary: GenerationTasksSummary = {
    total,
    completed: Number(summaryRow.completed ?? 0),
    failed: Number(summaryRow.failed ?? 0),
    in_progress: Number(summaryRow.in_progress ?? 0),
    queued: Number(summaryRow.queued ?? 0),
    reconciling: Number(summaryRow.reconciling ?? 0),
    cancelled: Number(summaryRow.cancelled ?? 0),
    p50_run_ms: p50RunMs,
    p95_run_ms: p95RunMs,
  }
  const statusCounts = emptyStatusCounts()
  if (statusRows) {
    for (const row of statusRows) {
      const statusKey = String(row.status) as TaskStatus
      if (statusKey in statusCounts) statusCounts[statusKey] = Number(row.count ?? 0)
    }
  } else {
    statusCounts.completed = summary.completed
    statusCounts.failed = summary.failed
    statusCounts.in_progress = summary.in_progress
    statusCounts.queued = summary.queued
    statusCounts.reconciling = summary.reconciling
    statusCounts.cancelled = summary.cancelled
  }
  return { summary, statusCounts }
}

export async function getGenerationTasks(
  handle: ReadModelsDbHandle,
  filters: GenerationTaskFilters,
  cursor?: string,
): Promise<GenerationTasksResult> {
  if (
    filters.minDurationSec !== undefined &&
    filters.maxDurationSec !== undefined &&
    filters.maxDurationSec < filters.minDurationSec
  )
    throw new TaskQueryError('最大耗时不能小于最小耗时')

  const window = taskWindow(filters)
  const paged = filters.page !== undefined
  const pageSize = filters.pageSize ?? (paged ? 50 : CURSOR_PAGE_SIZE)
  const page = filters.page ?? 1
  const customOrder = Boolean(
    (filters.sort && filters.sort !== 'submitted_at') || filters.dir === 'asc',
  )
  if (!paged && customOrder) throw new TaskQueryError('自定义排序仅支持页码分页，请传入 page 参数')

  const conditions = taskConditions(filters, window, { cursor: paged ? undefined : cursor })
  const where = sql.join(conditions, sql` AND `)
  const orderBy = taskOrderBy(filters)
  const { db } = handle
  if (paged) {
    const offset = (page - 1) * pageSize
    const [rows, summarySnapshot, windowFacets] = await Promise.all([
      db.execute(sql`
        ${TASK_SELECT_SQL}
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT ${pageSize} OFFSET ${offset}
      `) as Promise<unknown> as Promise<Row[]>,
      queryTaskSummarySnapshot(handle, filters, window, where),
      getWindowFacetOptions(handle, window),
    ])

    const { summary, statusCounts } = summarySnapshot
    const total = summary.total
    const facets: GenerationTasksFacets = {
      statusCounts,
      ...windowFacets,
    }

    const tasks = rows.map(mapGenerationTask)
    const last = tasks[tasks.length - 1]
    return {
      window,
      tasks,
      total,
      page,
      pageSize,
      summary,
      facets,
      nextCursor: offset + tasks.length < total && last ? `${last.submitted_at}_${last.id}` : null,
    }
  }
  const rows = (await db.execute(sql`
    ${TASK_SELECT_SQL}
    WHERE ${where}
    ORDER BY ${orderBy} LIMIT ${CURSOR_PAGE_SIZE + 1}
  `)) as unknown as Row[]
  const tasks = rows.slice(0, CURSOR_PAGE_SIZE).map(mapGenerationTask)
  const last = tasks[tasks.length - 1]
  return {
    window,
    tasks,
    nextCursor:
      !customOrder && rows.length > CURSOR_PAGE_SIZE && last
        ? `${last.submitted_at}_${last.id}`
        : null,
  }
}

export async function exportGenerationTasks(
  handle: ReadModelsDbHandle,
  filters: GenerationTaskFilters,
): Promise<{
  window: TimeWindow
  tasks: GenerationTaskItem[]
  truncated: boolean
}> {
  if (
    filters.minDurationSec !== undefined &&
    filters.maxDurationSec !== undefined &&
    filters.maxDurationSec < filters.minDurationSec
  )
    throw new TaskQueryError('最大耗时不能小于最小耗时')
  const window = taskWindow(filters)
  const rows = (await handle.db.execute(sql`
    ${TASK_SELECT_SQL}
    WHERE ${sql.join(taskConditions(filters, window), sql` AND `)}
    ORDER BY ${taskOrderBy(filters)}
    LIMIT ${EXPORT_CAP + 1}
  `)) as unknown as Row[]
  return {
    window,
    tasks: rows.slice(0, EXPORT_CAP).map(mapGenerationTask),
    truncated: rows.length > EXPORT_CAP,
  }
}

export function generationTasksCsv(tasks: ReadonlyArray<GenerationTaskItem>): string {
  const header = [
    'id',
    'submitted_at',
    'username',
    'user_id',
    'status',
    'error_type',
    'source',
    'provider',
    'model',
    'duration_seconds',
    'prompt',
    'queue_seconds',
    'attempt_count',
    'upstream_invocation_count',
    'upstream_status',
    'gpt_route',
    'gpt_key_fingerprint',
    'device_id',
  ]
  const cell = (value: string) => {
    const safe = /^[=+\-@]/.test(value) ? `'${value}` : value
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  const lines = tasks.map((task) => {
    const duration =
      task.started_at != null && task.completed_at != null && task.completed_at >= task.started_at
        ? ((task.completed_at - task.started_at) / 1000).toFixed(3)
        : ''
    const queue =
      task.started_at != null && task.started_at >= task.submitted_at
        ? ((task.started_at - task.submitted_at) / 1000).toFixed(3)
        : ''
    return [
      task.id,
      new Date(task.submitted_at).toISOString(),
      task.username ?? '',
      task.user_id ?? '',
      task.status,
      task.error_type ?? '',
      task.source,
      task.provider,
      task.model,
      duration,
      task.prompt,
      queue,
      String(task.attempt_count),
      String(task.upstream_invocation_count),
      task.upstream_status != null ? String(task.upstream_status) : '',
      task.gpt_route ?? '',
      task.gpt_key_fingerprint ?? '',
      task.device_id ?? '',
    ]
      .map((value) => cell(value))
      .join(',')
  })
  return `\uFEFF${[header.join(','), ...lines].join('\n')}\n`
}

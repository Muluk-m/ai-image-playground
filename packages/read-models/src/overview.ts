import { sql } from 'drizzle-orm'
import {
  getTaskVolume,
  getTaskVolumeBetween,
  mapGenerationTask,
  nullableNumber,
  nullableText,
  type ReadModelsDbHandle,
  type Row,
  rangeMs,
  reportedInputTokensSql,
  requestedImageCountSql,
  TASK_SELECT_SQL,
  toEpochMs,
  volumeBuckets,
  volumeBucketUnit,
} from './sql-helpers'
import {
  type GenerationActor,
  type GenerationUsersOverview,
  type OverviewActivityResult,
  type OverviewPulseBucket,
  type OverviewPulseWindow,
  type OverviewResult,
  type Range,
  type TimeWindow,
  type TodayModelFailure,
  type TodayModelStat,
  type TodayOverviewResult,
  todayWindow,
  type VolumeBucketUnit,
} from './types'

const ACTOR_LIMIT = 500

const EMPTY_PULSE_BUCKET: Omit<OverviewPulseBucket, 'bucket_at'> = {
  tasks: 0,
  images: 0,
  active: 0,
  signups: 0,
  agent_completed: 0,
  agent_failed: 0,
  agent_aborted: 0,
}

/**
 * 概览的环比与走势。当前窗与上一个同长度窗口各数一遍；走势与任务量图同一套分桶。
 * 「活跃」把账号与匿名设备一起数：两类入口都在用，只数账号会把匿名用量整块漏掉。
 */
async function getPulse(
  handle: ReadModelsDbHandle,
  range: Range,
  bucketAts: readonly number[],
  at: Date,
  clock?: { since: Date; previousSince: Date; unit: VolumeBucketUnit },
): Promise<OverviewResult['pulse']> {
  const { db } = handle
  const current = clock?.since ?? new Date(at.getTime() - rangeMs(range))
  const previous = clock?.previousSince ?? new Date(at.getTime() - 2 * rangeMs(range))
  const submittedCap = clock ? sql`AND submitted_at <= ${at}` : sql``
  const createdCap = clock ? sql`AND created_at <= ${at}` : sql``
  // agent_turns 与 agent_conversations 都有 created_at。今天这种 from/to 窗口补的上界
  // 若不带表别名，空库也会 500：column reference "created_at" is ambiguous。
  const turnCreatedCap = clock ? sql`AND t.created_at <= ${at}` : sql``
  const unitSql = clock ? (clock.unit === 'hour' ? sql`'hour'` : sql`'day'`) : undefined
  const { unit, start } = clock
    ? {
        unit: unitSql!,
        start: sql`DATE_TRUNC(${unitSql!}, ${current}::timestamptz)`,
      }
    : volumeBuckets(range, at)
  // 走势的首格可能早于当前窗起点（按整点或整天对齐），取数下界取两者更早的那个。
  const floor = sql`LEAST(${previous}::timestamptz, ${start})`
  // 视频任务也走这个队列，不算出图。张数读不出整数时按 1，不要让 ::integer 打垮整页。
  const images = sql`CASE WHEN request_payload->'video' IS NULL
    THEN ${requestedImageCountSql} ELSE 0 END`
  const actors = sql`
    SELECT submitted_at AS at, COALESCE(user_id, device_id) AS actor
    FROM queue_tasks
    WHERE submitted_at >= ${floor} ${submittedCap}
    UNION ALL
    SELECT t.created_at, COALESCE(c.user_id, c.device_id)
    FROM agent_turns t
    JOIN agent_conversations c ON c.id = t.conversation_id
    WHERE t.created_at >= ${floor} ${turnCreatedCap}
  `

  const [taskRows, actorRows, signupRows, agentRows, seriesRows] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE submitted_at >= ${current}) AS tasks_cur,
        COUNT(*) FILTER (WHERE submitted_at < ${current}) AS tasks_prev,
        COUNT(*) FILTER (WHERE status = 'completed' AND submitted_at >= ${current}) AS completed_cur,
        COUNT(*) FILTER (WHERE status = 'completed' AND submitted_at < ${current}) AS completed_prev,
        COUNT(*) FILTER (WHERE status = 'failed' AND submitted_at >= ${current}) AS failed_cur,
        COUNT(*) FILTER (WHERE status = 'failed' AND submitted_at < ${current}) AS failed_prev,
        COALESCE(SUM(${images}) FILTER (WHERE status = 'completed' AND submitted_at >= ${current}), 0) AS images_cur,
        COALESCE(SUM(${images}) FILTER (WHERE status = 'completed' AND submitted_at < ${current}), 0) AS images_prev
      FROM queue_tasks
      WHERE submitted_at >= ${previous} ${submittedCap}
    `),
    db.execute(sql`
      SELECT
        COUNT(DISTINCT actor) FILTER (WHERE at >= ${current}) AS active_cur,
        COUNT(DISTINCT actor) FILTER (WHERE at >= ${previous} AND at < ${current}) AS active_prev
      FROM (${actors}) a
      WHERE actor IS NOT NULL
    `),
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= ${current}) AS signups_cur,
        COUNT(*) FILTER (WHERE created_at < ${current}) AS signups_prev
      FROM users
      WHERE created_at >= ${previous} ${createdCap}
    `),
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= ${current}) AS turns_cur,
        COUNT(*) FILTER (WHERE created_at < ${current}) AS turns_prev,
        COUNT(*) FILTER (WHERE stop_reason = 'failed' AND created_at >= ${current}) AS failed_cur,
        COUNT(*) FILTER (WHERE stop_reason = 'failed' AND created_at < ${current}) AS failed_prev,
        COUNT(*) FILTER (WHERE stop_reason = 'aborted' AND created_at >= ${current}) AS aborted_cur,
        COUNT(*) FILTER (WHERE stop_reason = 'aborted' AND created_at < ${current}) AS aborted_prev
      FROM agent_turns
      WHERE created_at >= ${previous} ${createdCap}
    `),
    db.execute(sql`
      WITH
        tasks_by AS (
          SELECT DATE_TRUNC(${unit}, submitted_at) AS bucket,
                 COUNT(*) AS tasks,
                 COALESCE(SUM(${images}) FILTER (WHERE status = 'completed'), 0) AS images
          FROM queue_tasks WHERE submitted_at >= ${start} ${submittedCap} GROUP BY 1
        ),
        actors_by AS (
          SELECT DATE_TRUNC(${unit}, at) AS bucket, COUNT(DISTINCT actor) AS active
          FROM (${actors}) a WHERE actor IS NOT NULL AND at >= ${start} GROUP BY 1
        ),
        signups_by AS (
          SELECT DATE_TRUNC(${unit}, created_at) AS bucket, COUNT(*) AS signups
          FROM users WHERE created_at >= ${start} ${createdCap} GROUP BY 1
        ),
        agent_by AS (
          SELECT DATE_TRUNC(${unit}, created_at) AS bucket,
                 COUNT(*) FILTER (WHERE stop_reason = 'completed') AS agent_completed,
                 COUNT(*) FILTER (WHERE stop_reason = 'failed') AS agent_failed,
                 COUNT(*) FILTER (WHERE stop_reason = 'aborted') AS agent_aborted
          FROM agent_turns WHERE created_at >= ${start} ${createdCap} GROUP BY 1
        ),
        keys AS (
          SELECT bucket FROM tasks_by UNION SELECT bucket FROM actors_by
          UNION SELECT bucket FROM signups_by UNION SELECT bucket FROM agent_by
        )
      SELECT
        EXTRACT(EPOCH FROM k.bucket) * 1000 AS bucket_at,
        COALESCE(t.tasks, 0) AS tasks,
        COALESCE(t.images, 0) AS images,
        COALESCE(a.active, 0) AS active,
        COALESCE(s.signups, 0) AS signups,
        COALESCE(g.agent_completed, 0) AS agent_completed,
        COALESCE(g.agent_failed, 0) AS agent_failed,
        COALESCE(g.agent_aborted, 0) AS agent_aborted
      FROM keys k
      LEFT JOIN tasks_by t ON t.bucket = k.bucket
      LEFT JOIN actors_by a ON a.bucket = k.bucket
      LEFT JOIN signups_by s ON s.bucket = k.bucket
      LEFT JOIN agent_by g ON g.bucket = k.bucket
    `),
  ])

  const t = (taskRows as unknown as Row[])[0] ?? {}
  const a = (actorRows as unknown as Row[])[0] ?? {}
  const u = (signupRows as unknown as Row[])[0] ?? {}
  const g = (agentRows as unknown as Row[])[0] ?? {}
  const window = (suffix: 'cur' | 'prev'): OverviewPulseWindow => ({
    tasks: Number(t[`tasks_${suffix}`] ?? 0),
    completed: Number(t[`completed_${suffix}`] ?? 0),
    failed: Number(t[`failed_${suffix}`] ?? 0),
    images: Number(t[`images_${suffix}`] ?? 0),
    active: Number(a[`active_${suffix}`] ?? 0),
    signups: Number(u[`signups_${suffix}`] ?? 0),
    agent_turns: Number(g[`turns_${suffix}`] ?? 0),
    agent_failed: Number(g[`failed_${suffix}`] ?? 0),
    agent_aborted: Number(g[`aborted_${suffix}`] ?? 0),
  })
  const byBucket = new Map(
    (seriesRows as unknown as Row[]).map((row) => [
      Number(row.bucket_at),
      {
        tasks: Number(row.tasks),
        images: Number(row.images),
        active: Number(row.active),
        signups: Number(row.signups),
        agent_completed: Number(row.agent_completed),
        agent_failed: Number(row.agent_failed),
        agent_aborted: Number(row.agent_aborted),
      },
    ]),
  )
  return {
    current: window('cur'),
    previous: window('prev'),
    series: bucketAts.map((bucket_at) => ({
      bucket_at,
      ...(byBucket.get(bucket_at) ?? EMPTY_PULSE_BUCKET),
    })),
  }
}

export async function getOverview(
  handle: ReadModelsDbHandle,
  range: Range,
  custom?: TimeWindow,
): Promise<OverviewResult> {
  const { db } = handle
  // 整个请求只取一次「现在」：窗口、上期与分桶都从它算，彼此对得上。
  const customSpan = custom ? custom.to - custom.from : undefined
  const at = custom ? new Date(custom.to) : new Date()
  const since = custom ? new Date(custom.from) : new Date(at.getTime() - rangeMs(range))
  const previousSince = custom
    ? new Date(custom.from - (customSpan ?? 0))
    : new Date(at.getTime() - 2 * rangeMs(range))
  const customUnit: VolumeBucketUnit | undefined =
    customSpan === undefined ? undefined : customSpan <= 2 * 86_400_000 ? 'hour' : 'day'
  const submittedCap = custom ? sql`AND submitted_at <= ${at}` : sql``
  const startedCap = custom ? sql`AND started_at <= ${at}` : sql``

  const [summaryRowsRaw, volume, failureRowsRaw, modelRowsRaw, cacheRowsRaw, phaseRowsRaw] =
    await Promise.all([
      db.execute(sql`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        PERCENTILE_DISC(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
        ) FILTER (WHERE started_at IS NOT NULL AND completed_at IS NOT NULL) AS p50_duration_ms,
        PERCENTILE_DISC(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
        ) FILTER (WHERE started_at IS NOT NULL AND completed_at IS NOT NULL) AS p95_duration_ms,
        COALESCE(SUM(upstream_invocation_count), 0) AS upstream_invocations,
        PERCENTILE_DISC(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (started_at - submitted_at)) * 1000
        ) FILTER (WHERE started_at IS NOT NULL) AS queue_p50_ms
      FROM queue_tasks
      WHERE submitted_at >= ${since} ${submittedCap}
    `),
      customUnit
        ? getTaskVolumeBetween(handle, since, at, customUnit)
        : getTaskVolume(handle, range, undefined, at),
      db.execute(sql`
      SELECT
        COALESCE(error_type, 'unknown') AS error_type,
        COUNT(*) FILTER (WHERE submitted_at >= ${since}) AS count,
        COUNT(*) FILTER (WHERE submitted_at < ${since}) AS previous_count
      FROM queue_tasks
      WHERE submitted_at >= ${previousSince} ${submittedCap} AND status = 'failed'
      GROUP BY COALESCE(error_type, 'unknown')
      HAVING COUNT(*) FILTER (WHERE submitted_at >= ${since}) > 0
      ORDER BY count DESC, error_type
    `),
      db.execute(sql`
      SELECT
        model,
        COUNT(*) AS count,
        COALESCE(SUM(upstream_invocation_count), 0) AS upstream_invocations,
        AVG(
          upstream_invocation_count::double precision
            / ${requestedImageCountSql}
        ) FILTER (WHERE status IN ('completed', 'failed', 'cancelled')) AS average_multiplier,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        PERCENTILE_DISC(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (started_at - submitted_at)) * 1000
        ) FILTER (WHERE started_at IS NOT NULL) AS queue_p50_ms,
        PERCENTILE_DISC(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
        ) FILTER (WHERE status = 'completed' AND started_at IS NOT NULL) AS run_p95_ms
      FROM queue_tasks
      WHERE submitted_at >= ${since} ${submittedCap}
      GROUP BY model
      ORDER BY count DESC, model
    `),
      db.execute(sql`
      SELECT
        model,
        COUNT(*) AS calls,
        SUM(${reportedInputTokensSql}) AS input_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens
      FROM agent_model_calls
      WHERE started_at >= ${since} ${startedCap}
        AND purpose = 'conversation'
        AND usage IS NOT NULL
        AND cache_read_tokens IS NOT NULL
        AND ${reportedInputTokensSql} > 0
      GROUP BY model
      ORDER BY input_tokens DESC, model
    `),
      // 首调按整轮排序，窗口之前的早先调用也算；未派发、本地拒绝或没报用量的尝试不占首调位。
      db.execute(sql`
      WITH ranked AS (
        SELECT
          started_at,
          ${reportedInputTokensSql} AS input_tokens,
          cache_read_tokens,
          ROW_NUMBER() OVER (
            PARTITION BY conversation_id, turn_id ORDER BY started_at, id
          ) = 1 AS first_call
        FROM agent_model_calls
        WHERE purpose = 'conversation'
          AND usage IS NOT NULL
          AND ${reportedInputTokensSql} > 0
          AND local_rejection IS NULL
          AND COALESCE(http_dispatch_count, 1) > 0
          AND (conversation_id, turn_id) IN (
            SELECT conversation_id, turn_id FROM agent_model_calls
            WHERE started_at >= ${since} ${startedCap} AND purpose = 'conversation'
          )
      )
      SELECT
        first_call,
        COUNT(*) AS calls,
        SUM(input_tokens) AS input_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens
      FROM ranked
      WHERE started_at >= ${since} ${startedCap} AND cache_read_tokens IS NOT NULL
      GROUP BY first_call
    `),
    ])

  const pulse = await getPulse(
    handle,
    range,
    volume.map((bucket) => bucket.bucket_at),
    at,
    customUnit ? { since, previousSince, unit: customUnit } : undefined,
  )
  const summary = (summaryRowsRaw as unknown as Row[])[0] ?? {}
  const agentCacheModels = (cacheRowsRaw as unknown as Row[]).map((row) => ({
    model: String(row.model),
    calls: Number(row.calls),
    input_tokens: Number(row.input_tokens),
    cache_read_tokens: Number(row.cache_read_tokens),
  }))
  const phaseRows = phaseRowsRaw as unknown as Row[]
  const cachePhase = (first: boolean) => {
    const row = phaseRows.find((one) => one.first_call === first)
    return {
      calls: Number(row?.calls ?? 0),
      input_tokens: Number(row?.input_tokens ?? 0),
      cache_read_tokens: Number(row?.cache_read_tokens ?? 0),
    }
  }
  const firstCall = cachePhase(true)
  const continuation = cachePhase(false)
  const completed = Number(summary.completed ?? 0)
  const failed = Number(summary.failed ?? 0)
  const terminal = completed + failed
  return {
    summary: {
      total: Number(summary.total ?? 0),
      completed,
      failed,
      success_rate: terminal === 0 ? 0 : completed / terminal,
      p50_duration_ms: nullableNumber(summary.p50_duration_ms),
      p95_duration_ms: nullableNumber(summary.p95_duration_ms),
      upstream_invocations: Number(summary.upstream_invocations ?? 0),
      queue_p50_ms: nullableNumber(summary.queue_p50_ms),
    },
    pulse,
    volume,
    volume_bucket: customUnit ?? volumeBucketUnit(range),
    failures: (failureRowsRaw as unknown as Row[]).map((row) => ({
      error_type: String(row.error_type),
      count: Number(row.count),
      previous_count: Number(row.previous_count),
    })),
    agent_cache: {
      calls: firstCall.calls + continuation.calls,
      input_tokens: firstCall.input_tokens + continuation.input_tokens,
      cache_read_tokens: firstCall.cache_read_tokens + continuation.cache_read_tokens,
      first_call: firstCall,
      continuation,
      models: agentCacheModels,
    },
    models: (modelRowsRaw as unknown as Row[]).map((row) => ({
      model: String(row.model),
      count: Number(row.count),
      upstream_invocations: Number(row.upstream_invocations),
      average_multiplier: nullableNumber(row.average_multiplier),
      completed: Number(row.completed),
      failed: Number(row.failed),
      queue_p50_ms: nullableNumber(row.queue_p50_ms),
      run_p95_ms: nullableNumber(row.run_p95_ms),
    })),
  }
}

function modelFailures(rows: Row[]): Map<string, TodayModelFailure[]> {
  const grouped = new Map<string, TodayModelFailure[]>()
  for (const row of rows) {
    const model = String(row.model)
    const failures = grouped.get(model) ?? []
    failures.push({ error_type: String(row.error_type), count: Number(row.count) })
    grouped.set(model, failures)
  }
  for (const failures of grouped.values()) {
    failures.sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count
      if (left.error_type < right.error_type) return -1
      if (left.error_type > right.error_type) return 1
      return 0
    })
  }
  return grouped
}

export async function getTodayOverview(
  handle: ReadModelsDbHandle,
  now = Date.now(),
): Promise<TodayOverviewResult> {
  return getGenerationOverview(handle, todayWindow(now))
}

export async function getGenerationOverview(
  handle: ReadModelsDbHandle,
  window: TimeWindow,
): Promise<TodayOverviewResult> {
  const from = new Date(window.from)
  const to = new Date(window.to)
  const { db } = handle
  const [overview, modelRows, failureRows] = await Promise.all([
    getGenerationUsers(handle, window),
    db.execute(sql`
      SELECT model,
        COUNT(*) AS tasks,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        COALESCE(SUM(upstream_invocation_count), 0) AS upstream_invocations
      FROM queue_tasks
      WHERE submitted_at >= ${from} AND submitted_at <= ${to}
      GROUP BY model
      ORDER BY COUNT(*) DESC, model
    `),
    db.execute(sql`
      SELECT model,
        COALESCE(error_type, 'unknown') AS error_type,
        COUNT(*) AS count
      FROM queue_tasks
      WHERE submitted_at >= ${from} AND submitted_at <= ${to}
        AND status = 'failed'
      GROUP BY model, COALESCE(error_type, 'unknown')
    `),
  ])
  const failuresByModel = modelFailures(failureRows as unknown as Row[])
  return {
    ...overview,
    models: (modelRows as unknown as Row[]).map(
      (row): TodayModelStat => ({
        model: String(row.model),
        tasks: Number(row.tasks),
        completed: Number(row.completed),
        failed: Number(row.failed),
        upstream_invocations: Number(row.upstream_invocations),
        failures: failuresByModel.get(String(row.model)) ?? [],
      }),
    ),
  }
}

export async function getGenerationUsers(
  handle: ReadModelsDbHandle,
  window: TimeWindow,
): Promise<GenerationUsersOverview> {
  const from = new Date(window.from)
  const to = new Date(window.to)
  const actorRows = await handle.db.execute(sql`
    WITH actors AS (
      SELECT CASE WHEN t.user_id IS NOT NULL THEN 'user'
        WHEN t.device_id IS NOT NULL THEN 'device' ELSE 'unassigned' END AS kind,
        COALESCE(t.user_id, t.device_id) AS actor_id,
        COUNT(*) AS tasks,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress,
        COUNT(*) FILTER (WHERE status = 'queued') AS queued,
        COUNT(*) FILTER (WHERE status = 'reconciling') AS reconciling,
        MAX(submitted_at) AS last_submitted_at
      FROM queue_tasks t
      WHERE submitted_at >= ${from} AND submitted_at <= ${to}
      GROUP BY 1, 2
    )
    SELECT a.*, u.username, n.note, COUNT(*) OVER() AS actor_count,
      COUNT(*) FILTER (WHERE a.kind = 'user') OVER() AS users,
      COUNT(*) FILTER (WHERE a.kind = 'device') OVER() AS devices,
      SUM(a.tasks) OVER() AS total_tasks, SUM(a.completed) OVER() AS total_completed,
      SUM(a.failed) OVER() AS total_failed, SUM(a.in_progress) OVER() AS total_in_progress,
      SUM(a.queued) OVER() AS total_queued, SUM(a.reconciling) OVER() AS total_reconciling
    FROM actors a
    LEFT JOIN users u ON a.kind = 'user' AND u.id = a.actor_id
    LEFT JOIN admin_user_notes n ON n.user_id = u.id
    ORDER BY a.last_submitted_at DESC, a.kind, a.actor_id
    LIMIT ${ACTOR_LIMIT}
  `)
  const rows = actorRows as unknown as Row[]
  const totals = rows[0] ?? {}
  return {
    window,
    summary: {
      users: Number(totals.users ?? 0),
      devices: Number(totals.devices ?? 0),
      tasks: Number(totals.total_tasks ?? 0),
      completed: Number(totals.total_completed ?? 0),
      failed: Number(totals.total_failed ?? 0),
      in_progress: Number(totals.total_in_progress ?? 0),
      queued: Number(totals.total_queued ?? 0),
      reconciling: Number(totals.total_reconciling ?? 0),
    },
    truncated: Number(totals.actor_count ?? 0) > ACTOR_LIMIT,
    actors: rows.map(
      (row): GenerationActor => ({
        kind: row.kind as GenerationActor['kind'],
        id: nullableText(row.actor_id),
        username: nullableText(row.username),
        note: nullableText(row.note),
        tasks: Number(row.tasks),
        completed: Number(row.completed),
        failed: Number(row.failed),
        in_progress: Number(row.in_progress),
        queued: Number(row.queued),
        reconciling: Number(row.reconciling),
        last_submitted_at: toEpochMs(row.last_submitted_at),
      }),
    ),
  }
}

export interface OverviewActivityOptions {
  /**
   * 外部日志源注入端口（如 Admin 的 OpenObserve / serverLogSource）。
   * 未提供时按 `availability: 'off'` 返回空服务端错误，保持 `packages/read-models` 零观测客户端耦合。
   */
  readServerErrors?: (window: TimeWindow) => Promise<OverviewActivityResult['server']>
}

export async function getOverviewActivity(
  handle: ReadModelsDbHandle,
  window: TimeWindow,
  options: OverviewActivityOptions = {},
): Promise<OverviewActivityResult> {
  const from = new Date(window.from)
  const to = new Date(window.to)
  const { db } = handle
  const [tasks, server, client] = await Promise.all([
    db.execute(sql`
      ${TASK_SELECT_SQL}
      WHERE t.submitted_at >= ${from} AND t.submitted_at <= ${to}
      ORDER BY t.submitted_at DESC, t.id DESC LIMIT 10
    `),
    options.readServerErrors
      ? options.readServerErrors(window)
      : Promise.resolve<OverviewActivityResult['server']>({
          availability: 'off',
          total: 0,
          entries: [],
        }),
    db.execute(sql`
      SELECT e.id, e.received_at AS at, e.fingerprint, e.stack, e.user_id, e.device_id, u.username,
        CASE WHEN e.name IS NULL THEN e.message ELSE e.name || ': ' || e.message END AS message,
        COUNT(*) OVER() AS total
      FROM client_errors e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.received_at >= ${from} AND e.received_at <= ${to}
      ORDER BY e.received_at DESC, e.id DESC LIMIT 5
    `),
  ])
  const taskRows = tasks as unknown as Row[]
  const clientRows = client as unknown as Row[]
  return {
    window,
    tasks: taskRows.map(mapGenerationTask),
    server,
    client: {
      total: Number(clientRows[0]?.total ?? 0),
      entries: clientRows.map((row) => ({
        id: String(row.id),
        at: toEpochMs(row.at),
        message: String(row.message),
        stack: nullableText(row.stack),
        fingerprint: String(row.fingerprint),
        user_id: nullableText(row.user_id),
        device_id: nullableText(row.device_id),
        username: nullableText(row.username),
      })),
    },
  }
}

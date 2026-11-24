import { OAUTH_ONLY_PASSWORD_HASH, schema } from '@image-playground/db'
import { and, eq, notExists, sql } from 'drizzle-orm'
import {
  decodeCursor,
  encodeCursor,
  getTaskVolume,
  mapTaskListItem,
  nullableEpochMs,
  type ReadModelsDb,
  type ReadModelsDbHandle,
  type ReadModelsQueryExecutor,
  type Row,
  TASK_LIST_COLUMNS,
  toEpochMs,
  volumeBucketUnit,
} from './sql-helpers'
import type {
  AdminUserRow,
  ListUsersResult,
  Range,
  UserDetailResult,
  UserKpis,
  UserListOptions,
  UserTasksResult,
} from './types'
import { buildUserSegmentCountPlan, userSegmentFilters } from './user-segments'

const PAGE_SIZE = 100
// 用户详情按全量历史统计；只有趋势图固定看近 30 天，不由调用方决定。
const USER_VOLUME_RANGE: Range = '30d'

/**
 * 尚未迁移进 `media_objects` 的旧版 `user_asset_objects` 字节总和。
 * `mediaUsage` 汇总 `media_objects.reserved_bytes` 后仅叠加此部分，避免双写/回填期间重复计费。
 */
export async function readUnmigratedUserAssetBytes(
  executor: ReadModelsQueryExecutor,
  userId: string,
): Promise<number> {
  const [row] = await executor
    .select({ total: sql<string | number>`coalesce(sum(${schema.user_asset_objects.bytes}), 0)` })
    .from(schema.user_asset_objects)
    .where(
      and(
        eq(schema.user_asset_objects.user_id, userId),
        notExists(
          executor
            .select({ id: schema.media_objects.id })
            .from(schema.media_objects)
            .where(
              and(
                eq(schema.media_objects.user_id, schema.user_asset_objects.user_id),
                eq(schema.media_objects.asset_image_id, schema.user_asset_objects.image_id),
              ),
            ),
        ),
      ),
    )
  return Number(row?.total ?? 0)
}

/**
 * 单个用户已上传的素材对象字节总和（统一 `media_objects` 账本 + 尚未回填的旧 `user_asset_objects`，严格去重）。
 * 在单条 SQL 语句中求值，保证与在线回填并发时两部分看到同一 MVCC 快照，不漏计也不双计。
 * BFF（`sync:user-asset-bytes`）与 Admin（`getUserDetail.asset_bytes`）共用此口径，
 * 避免两处各自计算导致限额校验与后台展示分叉。
 * sum() 出来是 bigint，别往 int4 上转——运营把每用户配额调过 2 GB 之后会溢出报错。
 */
export async function readUserAssetBytes(
  executor: ReadModelsQueryExecutor,
  userId: string,
): Promise<number> {
  const rows = (await executor.execute(sql`
    SELECT (
      COALESCE(
        (SELECT SUM(m.bytes) FROM media_objects m
         WHERE m.user_id = ${userId}
           AND m.asset_image_id IS NOT NULL
           AND m.status <> 'deleting'),
        0
      )
      + COALESCE(
        (SELECT SUM(a.bytes) FROM user_asset_objects a
         WHERE a.user_id = ${userId}
           AND NOT EXISTS (
             SELECT 1 FROM media_objects m
             WHERE m.user_id = a.user_id AND m.asset_image_id = a.image_id
           )),
        0
      )
    ) AS total
  `)) as unknown as Array<{ total?: string | number }>
  return Number(rows[0]?.total ?? 0)
}

function mapAdminUser(row: Row): AdminUserRow {
  return {
    id: String(row.id),
    username: String(row.username),
    note: typeof row.note === 'string' ? row.note : null,
    status: row.status === 'disabled' ? 'disabled' : 'active',
    created_at: toEpochMs(row.created_at),
    updated_at: toEpochMs(row.updated_at),
    last_login_at: nullableEpochMs(row.last_login_at),
    login_methods: Array.isArray(row.login_methods) ? row.login_methods.map(String) : [],
    last_task_at: nullableEpochMs(row.last_task_at),
    last_activity_at: nullableEpochMs(row.last_activity_at),
    active_sessions: Number(row.active_sessions),
    task_count: Number(row.task_count),
  }
}

const LOGIN_METHODS_SQL = sql`
  ARRAY(
    SELECT method
    FROM (
      SELECT 'password'::text AS method, 0 AS sort
      WHERE u.password_hash <> ${OAUTH_ONLY_PASSWORD_HASH}
      UNION
      SELECT i.provider AS method, 1 AS sort
      FROM user_identities i
      WHERE i.user_id = u.id
    ) methods
    ORDER BY sort, method
  ) AS login_methods
`

const ADMIN_USER_PROJECTION = sql`
  u.id,
  u.username,
  n.note,
  u.status,
  u.created_at,
  u.updated_at,
  u.last_login_at,
  ${LOGIN_METHODS_SQL},
  task_stats.last_task_at,
  GREATEST(u.last_login_at, task_stats.last_task_at) AS last_activity_at,
  COALESCE(session_stats.active_sessions, 0) AS active_sessions,
  COALESCE(task_stats.task_count, 0) AS task_count
`

const ACTIVE_SESSION_JOIN = sql`
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS active_sessions
    FROM (
      SELECT f.id
      FROM user_session_families f
      WHERE f.user_id = u.id
        AND f.revoked_at IS NULL
        AND f.refresh_expires_at > NOW()
        AND f.absolute_expires_at > NOW()
      UNION
      SELECT s.token_hash
      FROM user_sessions s
      WHERE s.user_id = u.id
        AND s.family_id IS NULL
        AND s.expires_at > NOW()
    ) active
  ) session_stats ON TRUE
`

// 与 readUserAssetBytes 保持同一分母定义（统一 media_objects + 未回填的 user_asset_objects 去重求和），别改成「活素材引用到的图片」。
const SYNC_FOOTPRINT = sql`
  (SELECT COUNT(*) FROM user_templates WHERE user_id = u.id AND deleted_at IS NULL) AS template_count,
  (SELECT COUNT(*) FROM user_assets WHERE user_id = u.id AND deleted_at IS NULL) AS asset_count,
  (
    COALESCE(
      (SELECT SUM(m.bytes) FROM media_objects m
       WHERE m.user_id = u.id
         AND m.asset_image_id IS NOT NULL
         AND m.status <> 'deleting'),
      0
    )
    + COALESCE(
      (SELECT SUM(a.bytes) FROM user_asset_objects a
       WHERE a.user_id = u.id
         AND NOT EXISTS (
           SELECT 1 FROM media_objects m
           WHERE m.user_id = a.user_id AND m.asset_image_id = a.image_id
         )),
      0
    )
  ) AS asset_bytes
`

export async function listUsers(
  handle: ReadModelsDbHandle,
  search = '',
  options: UserListOptions = {},
): Promise<ListUsersResult> {
  const { db } = handle
  const term = search.trim().toLowerCase()
  const pageSize = options.pageSize === 100 ? 100 : 50
  const page = Math.min(Math.max(options.page ?? 1, 1), 10_000)
  const offset = (page - 1) * pageSize
  const direction = options.dir === 'asc' ? sql`ASC` : sql`DESC`
  const orderBy =
    options.sort === 'created'
      ? sql`u.created_at ${direction}, u.id ${direction}`
      : options.sort === 'login'
        ? sql`u.last_login_at ${direction} NULLS LAST, u.id ${direction}`
        : sql`last_activity_at ${direction} NULLS LAST, u.created_at DESC, u.id DESC`
  const filters = term
    ? [
        sql`(POSITION(${term} IN LOWER(u.username)) > 0
           OR POSITION(${term} IN LOWER(u.id)) > 0
           OR POSITION(${term} IN LOWER(COALESCE(n.note, ''))) > 0)`,
      ]
    : [sql`TRUE`]
  if (options.status) filters.push(sql`u.status = ${options.status}`)
  if (options.registeredFrom !== undefined)
    filters.push(sql`u.created_at >= ${new Date(options.registeredFrom)}`)
  if (options.registeredTo !== undefined)
    filters.push(sql`u.created_at <= ${new Date(options.registeredTo)}`)
  if (options.activeFrom !== undefined)
    filters.push(sql`(
      u.last_login_at >= ${new Date(options.activeFrom)}
      OR EXISTS (
        SELECT 1 FROM queue_tasks t
        WHERE t.user_id = u.id AND t.submitted_at >= ${new Date(options.activeFrom)}
      )
    )`)
  if (options.activeTo !== undefined)
    filters.push(sql`(
      (u.last_login_at IS NULL OR u.last_login_at <= ${new Date(options.activeTo)})
      AND NOT EXISTS (
        SELECT 1 FROM queue_tasks t
        WHERE t.user_id = u.id AND t.submitted_at > ${new Date(options.activeTo)}
      )
    )`)
  const scope = sql.join(filters, sql` AND `)
  const now = Date.now()
  const segments =
    options.segment || options.segments
      ? await userSegmentFilters(db, {
          billingCreditsEnabled: options.billingCreditsEnabled,
          now,
        })
      : null
  const segmentFilter = options.segment ? (segments?.get(options.segment) ?? sql`FALSE`) : sql`TRUE`
  const from = sql`FROM users u LEFT JOIN admin_user_notes n ON n.user_id = u.id`
  const countFrom = term ? from : sql`FROM users u`
  const where = sql`${scope} AND ${segmentFilter}`
  // 先在分页内选出当前页用户，再对这至多 50/100 行补查在线会话和登录方式，避免全表逐行做 LATERAL 连接。
  const userRowsPromise =
    options.sort === 'created' || options.sort === 'login'
      ? db.execute(sql`
          WITH page_users AS (
            SELECT
              u.id,
              u.username,
              u.password_hash,
              n.note,
              u.status,
              u.created_at,
              u.updated_at,
              u.last_login_at
            ${from}
            WHERE ${where}
            ORDER BY ${orderBy}
            LIMIT ${pageSize} OFFSET ${offset}
          )
          SELECT
            u.id,
            u.username,
            u.note,
            u.status,
            u.created_at,
            u.updated_at,
            u.last_login_at,
            ${LOGIN_METHODS_SQL},
            task_stats.last_task_at,
            GREATEST(u.last_login_at, task_stats.last_task_at) AS last_activity_at,
            COALESCE(session_stats.active_sessions, 0) AS active_sessions,
            COALESCE(task_stats.task_count, 0) AS task_count
          FROM page_users u
          ${ACTIVE_SESSION_JOIN}
          LEFT JOIN LATERAL (
            SELECT COUNT(*) AS task_count, MAX(t.submitted_at) AS last_task_at
            FROM queue_tasks t
            WHERE t.user_id = u.id
          ) task_stats ON TRUE
          ORDER BY ${orderBy}
        `)
      : db.execute(sql`
          WITH filtered_users AS (
            SELECT
              u.id,
              u.username,
              u.password_hash,
              n.note,
              u.status,
              u.created_at,
              u.updated_at,
              u.last_login_at
            ${from}
            WHERE ${where}
          ),
          task_summary AS (
            SELECT
              t.user_id,
              COUNT(*)::bigint AS task_count,
              MAX(t.submitted_at) AS last_task_at
            FROM queue_tasks t
            WHERE t.user_id IS NOT NULL
              AND t.user_id IN (SELECT id FROM filtered_users)
            GROUP BY t.user_id
          ),
          page_users AS (
            SELECT
              u.id,
              u.username,
              u.password_hash,
              u.note,
              u.status,
              u.created_at,
              u.updated_at,
              u.last_login_at,
              ts.last_task_at,
              GREATEST(u.last_login_at, ts.last_task_at) AS last_activity_at,
              COALESCE(ts.task_count, 0) AS task_count
            FROM filtered_users u
            LEFT JOIN task_summary ts ON ts.user_id = u.id
            ORDER BY last_activity_at ${direction} NULLS LAST, u.created_at DESC, u.id DESC
            LIMIT ${pageSize} OFFSET ${offset}
          )
          SELECT
            u.id,
            u.username,
            u.note,
            u.status,
            u.created_at,
            u.updated_at,
            u.last_login_at,
            ${LOGIN_METHODS_SQL},
            u.last_task_at,
            u.last_activity_at,
            COALESCE(session_stats.active_sessions, 0) AS active_sessions,
            u.task_count
          FROM page_users u
          ${ACTIVE_SESSION_JOIN}
          ORDER BY u.last_activity_at ${direction} NULLS LAST, u.created_at DESC, u.id DESC
        `)

  const countPlan = options.segments && segments ? buildUserSegmentCountPlan(segments, now) : null
  const countPromise = countPlan
    ? db.execute(sql`
        ${countPlan.ctes}
        SELECT
          COUNT(*)::int AS "all",
          ${countPlan.columns}
        ${countFrom}
        ${countPlan.joins}
        WHERE ${scope}
      `)
    : db.execute(sql`
        SELECT COUNT(*)::int AS "all"
        ${countFrom}
        WHERE ${where}
      `)

  const [userRowsRaw, [counts]] = await Promise.all([userRowsPromise, countPromise])
  const userRows = userRowsRaw as unknown as Row[]
  const segmentCounts: ListUsersResult['segments'] = options.segments
    ? { all: Number(counts?.all ?? 0) }
    : undefined
  if (segmentCounts) {
    for (const key of segments?.keys() ?? []) {
      segmentCounts[key] = Number(counts?.[key] ?? 0)
    }
  }
  const total =
    options.segment && !segments?.has(options.segment)
      ? 0
      : Number(counts?.[options.segments && options.segment ? options.segment : 'all'] ?? 0)
  const users = userRows.map(mapAdminUser)
  return {
    users,
    total,
    page,
    pageSize,
    truncated: offset + users.length < total,
    ...(segmentCounts ? { segments: segmentCounts } : {}),
  }
}

/** 全局 KPI 跟翻页无关。短缓存让连续翻页不再各扫一遍用户和 24 小时任务。 */
export const USER_KPI_CACHE_MS = 30_000

// 缓存跟着底层 Drizzle 实例走：同一进程换了 DATABASE_URL 时不拿别的库的数字，
// 也兼容调用方按结构类型内联传入 `{ db, schema }`。
let userKpiCache: { at: number; value: UserKpis; db: ReadModelsDb } | null = null
let userKpiPending: { promise: Promise<UserKpis>; db: ReadModelsDb; fresh: boolean } | null = null
let userKpiGeneration = 0
let userKpiCacheGeneration = 0

export function resetUserKpiCacheForTesting(): void {
  userKpiCache = null
  userKpiPending = null
  userKpiGeneration = 0
  userKpiCacheGeneration = 0
}

async function loadUserKpis(handle: ReadModelsDbHandle): Promise<UserKpis> {
  const { db } = handle
  const rows = (await db.execute(sql`
    WITH recent_task_users AS (
      SELECT DISTINCT user_id
      FROM queue_tasks
      WHERE user_id IS NOT NULL AND submitted_at >= NOW() - INTERVAL '7 days'
    ),
    recent_tasks AS (
      SELECT
        COUNT(*) AS submissions,
        COUNT(*) FILTER (WHERE status = 'failed') AS failures
      FROM queue_tasks
      WHERE submitted_at >= NOW() - INTERVAL '24 hours'
    )
    SELECT
      (SELECT COUNT(*) FROM users) AS total_users,
      (
        SELECT COUNT(*)
        FROM users u
        LEFT JOIN recent_task_users rtu ON rtu.user_id = u.id
        WHERE u.last_login_at >= NOW() - INTERVAL '7 days' OR rtu.user_id IS NOT NULL
      ) AS active_users_7d,
      recent_tasks.submissions AS submissions_24h,
      CASE
        WHEN recent_tasks.submissions = 0 THEN 0
        ELSE recent_tasks.failures::double precision / recent_tasks.submissions::double precision
      END AS failure_rate_24h
    FROM recent_tasks
  `)) as unknown as Row[]
  const kpi = rows[0] ?? {}
  return {
    total_users: Number(kpi.total_users ?? 0),
    active_users_7d: Number(kpi.active_users_7d ?? 0),
    submissions_24h: Number(kpi.submissions_24h ?? 0),
    failure_rate_24h: Number(kpi.failure_rate_24h ?? 0),
  }
}

export function getUserKpis(
  handle: ReadModelsDbHandle,
  now = Date.now(),
  fresh = false,
): Promise<UserKpis> {
  const db = handle.db
  if (!fresh && userKpiCache?.db === db && now - userKpiCache.at < USER_KPI_CACHE_MS)
    return Promise.resolve(userKpiCache.value)
  // 强制刷新不搭普通查询的车（它可能早于刚才的写入），但多次强制刷新共用一次扫描。
  if (userKpiPending?.db === db && (!fresh || userKpiPending.fresh)) return userKpiPending.promise
  // 手动刷新另起一次查询；代数让更早发起的查询晚到时不覆盖更新的缓存。
  const generation = ++userKpiGeneration
  const promise: Promise<UserKpis> = loadUserKpis(handle)
    .then((value) => {
      if (generation >= userKpiCacheGeneration) {
        userKpiCache = { at: now, value, db }
        userKpiCacheGeneration = generation
      }
      return value
    })
    .finally(() => {
      if (userKpiPending?.promise === promise) userKpiPending = null
    })
  userKpiPending = { promise, db, fresh }
  return promise
}

export async function getUserDetail(
  handle: ReadModelsDbHandle,
  userId: string,
  includeVolume = true,
): Promise<UserDetailResult | null> {
  const { db } = handle
  const [userRowsRaw, volume] = await Promise.all([
    db.execute(sql`
      SELECT ${ADMIN_USER_PROJECTION}, ${SYNC_FOOTPRINT}
      FROM users u
      LEFT JOIN admin_user_notes n ON n.user_id = u.id
      CROSS JOIN LATERAL (
        SELECT COUNT(*) AS task_count, MAX(t.submitted_at) AS last_task_at
        FROM queue_tasks t
        WHERE t.user_id = u.id
      ) task_stats
      ${ACTIVE_SESSION_JOIN}
      WHERE u.id = ${userId}
    `),
    includeVolume ? getTaskVolume(handle, USER_VOLUME_RANGE, userId) : [],
  ])
  const userRow = (userRowsRaw as unknown as Row[])[0]
  if (!userRow) return null
  return {
    user: mapAdminUser(userRow),
    volume,
    volume_bucket: volumeBucketUnit(USER_VOLUME_RANGE),
    volume_range: USER_VOLUME_RANGE,
    template_count: Number(userRow.template_count),
    asset_count: Number(userRow.asset_count),
    asset_bytes: Number(userRow.asset_bytes),
  }
}

export async function getUserTasks(
  handle: ReadModelsDbHandle,
  userId: string,
  statusFilter: string,
  cursor?: string,
): Promise<UserTasksResult> {
  const { db } = handle
  const cursorValue = decodeCursor(cursor)
  const keyset = cursorValue
    ? sql`AND (t.submitted_at < ${new Date(cursorValue.ts)}
        OR (t.submitted_at = ${new Date(cursorValue.ts)} AND t.id < ${cursorValue.id}))`
    : sql``
  const statusCondition =
    statusFilter && statusFilter !== 'all' ? sql`AND t.status = ${statusFilter}` : sql``

  const rows = (await db.execute(sql`
    SELECT t.*
    FROM (
      SELECT ${TASK_LIST_COLUMNS}, 'queue' AS kind
      FROM queue_tasks t
      WHERE t.user_id = ${userId}
      UNION ALL
      SELECT a.task_id AS id, 'openai-compat' AS provider, a.model, a.status,
        a.created_at AS submitted_at, c.dispatched_at AS started_at, a.completed_at,
        a.error_code AS error_type, NULL::integer AS upstream_status,
        NULL::text AS gpt_route, NULL::text AS gpt_key_fingerprint,
        jsonb_build_object('prompt', a.input_snapshot->>'prompt') AS request_payload,
        a.attempt AS attempt_count, COALESCE(c.http_dispatch_count, 0) AS upstream_invocation_count,
        a.origin_conversation_id AS agent_conversation_id,
        CASE WHEN a.origin_conversation_id IS NOT NULL THEN 'chat' ELSE 'manual' END AS source,
        'analysis' AS kind
      FROM analysis_tasks a
      LEFT JOIN analysis_model_calls c ON c.task_id = a.task_id
      WHERE a.user_id = ${userId}
    ) t
    WHERE TRUE
      ${statusCondition}
      ${keyset}
    ORDER BY t.submitted_at DESC, t.id DESC
    LIMIT ${PAGE_SIZE + 1}
  `)) as unknown as Row[]

  const hasMore = rows.length > PAGE_SIZE
  const tasks = rows.slice(0, PAGE_SIZE).map(mapTaskListItem)
  const last = tasks[tasks.length - 1]
  return {
    tasks,
    nextCursor: hasMore && last ? encodeCursor(last.submitted_at, last.id) : null,
  }
}

import { readFile } from 'node:fs/promises'
import { OPS_THRESHOLDS, QUEUE_TIMEOUTS } from '@image-playground/shared'
import { sql } from 'drizzle-orm'
import type {
  HostSample,
  OpsApi,
  OpsBackups,
  OpsBlock,
  OpsContainers,
  OpsDatabase,
  OpsDeployment,
  OpsDeployments,
  OpsHost,
  OpsQueue,
  OpsServices,
  OpsSnapshot,
} from '../../contracts'
import { config } from '../config'
import { getDbHandle } from './db'

/** 看板上列出来的卡住任务与大表的条数上限；再多也只是同一件事的重复。 */
const STUCK_TASK_LIMIT = 20
const LARGEST_TABLE_LIMIT = 8

type OpsData = {
  [K in Exclude<keyof OpsSnapshot, 'generated_at'>]: OpsSnapshot[K] extends OpsBlock<infer T>
    ? T
    : never
}

/** 每一块的取数函数。测试注入会抛错的那一个，来验证其余几块不受牵连。 */
export type OpsSources = { [K in keyof OpsData]: () => Promise<OpsData[K]> }

/** 任何一块最多等这么久。数据库挂起时查询不会自己回来，而那正是最需要看其余几块的时候。 */
const BLOCK_TIMEOUT_MS = 8_000

/**
 * 能原样给运营者看的失败原因。其余的错误（驱动、fetch）可能带着内部地址与角色名，
 * 只进服务端日志，看板上一律是一句固定的话。
 */
export class OpsReadError extends Error {}

function timeoutAfter(ms: number): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OpsReadError(`${Math.round(ms / 1000)} 秒内没有取到`)), ms)
  })
  return { promise, cancel: () => clearTimeout(timer) }
}

async function settle<T>(
  name: string,
  source: () => Promise<T>,
  timeoutMs: number,
): Promise<OpsBlock<T>> {
  const timeout = timeoutAfter(timeoutMs)
  try {
    return { ok: true, data: await Promise.race([source(), timeout.promise]) }
  } catch (error) {
    if (error instanceof OpsReadError) return { ok: false, error: error.message }
    console.error(`[ops] ${name} block failed`, error)
    return { ok: false, error: '取数失败，原因见后台服务日志' }
  } finally {
    timeout.cancel()
  }
}

/**
 * 各块并行取、各自失败、各自超时。出事的时候恰恰最需要看其余几块，所以任何一块抛错或挂起
 * 都只落在它自己身上。
 */
export async function buildOpsSnapshot(
  sources: OpsSources = defaultSources,
  timeoutMs: number = BLOCK_TIMEOUT_MS,
): Promise<OpsSnapshot> {
  const [queue, database, backup, services, host, containers, api, deployments] = await Promise.all(
    [
      settle('queue', sources.queue, timeoutMs),
      settle('database', sources.database, timeoutMs),
      settle('backup', sources.backup, timeoutMs),
      settle('services', sources.services, timeoutMs),
      settle('host', sources.host, timeoutMs),
      settle('containers', sources.containers, timeoutMs),
      settle('api', sources.api, timeoutMs),
      settle('deployments', sources.deployments, timeoutMs),
    ],
  )
  return {
    generated_at: Date.now(),
    host,
    services,
    queue,
    database,
    backup,
    containers,
    api,
    deployments,
  }
}

/**
 * 只看 `queue_tasks`（后台读不了裸 `tasks`），所以对话轮的滞留不在这一栏里。
 * 时长全部交给数据库的时钟算：`submitted_at` 是后端写进去的，拿后台进程的时钟去减会把
 * 两台机器的时钟差算进等待时长。
 */
async function readQueue(): Promise<OpsQueue> {
  const { db } = getDbHandle()
  const staleSeconds = QUEUE_TIMEOUTS.STALE_IN_PROGRESS_MS / 1000
  const [countsRaw, stuckRaw] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'queued') AS queued,
        COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress,
        EXTRACT(EPOCH FROM NOW() - MIN(submitted_at) FILTER (WHERE status = 'queued')) * 1000
          AS oldest_queued_wait_ms
      FROM queue_tasks
      WHERE status IN ('queued', 'in_progress')
    `),
    db.execute(sql`
      SELECT id, model, EXTRACT(EPOCH FROM started_at) * 1000 AS started_at
      FROM queue_tasks
      WHERE status = 'in_progress'
        AND started_at < NOW() - make_interval(secs => ${staleSeconds})
      ORDER BY started_at ASC
      LIMIT ${STUCK_TASK_LIMIT}
    `),
  ])
  const counts = (countsRaw as unknown as Array<Record<string, unknown>>)[0] ?? {}
  return {
    queued: Number(counts.queued ?? 0),
    in_progress: Number(counts.in_progress ?? 0),
    oldest_queued_wait_ms:
      counts.oldest_queued_wait_ms == null
        ? null
        : Math.max(0, Math.round(Number(counts.oldest_queued_wait_ms))),
    stale_after_ms: QUEUE_TIMEOUTS.STALE_IN_PROGRESS_MS,
    stuck: (stuckRaw as unknown as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      model: String(row.model),
      started_at: Math.round(Number(row.started_at)),
    })),
  }
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/** 每分钟一条、留 7 天，原样给前端是一万个点；按半小时取平均后三百多个，趋势一点不少。 */
async function readHost(): Promise<OpsHost> {
  const { db } = getDbHandle()
  const [latestRaw, seriesRaw] = await Promise.all([
    db.execute(sql`
      SELECT
        EXTRACT(EPOCH FROM sampled_at) * 1000 AS sampled_ms,
        disk_total_bytes, disk_available_bytes, mem_total_bytes, mem_available_bytes,
        cpu_count, cpu_busy_ratio, load_1, load_5, load_15, swap_total_bytes, swap_free_bytes,
        EXTRACT(EPOCH FROM booted_at) * 1000 AS booted_ms
      FROM host_samples
      ORDER BY sampled_at DESC
      LIMIT 1
    `),
    db.execute(sql`
      SELECT
        EXTRACT(EPOCH FROM date_bin('30 minutes', sampled_at, TIMESTAMPTZ '2000-01-01')) * 1000 AS at,
        AVG(1 - disk_available_bytes::double precision / disk_total_bytes) AS disk_used_ratio,
        AVG(mem_available_bytes::double precision / mem_total_bytes) AS mem_available_ratio,
        AVG(cpu_busy_ratio) AS cpu_busy_ratio
      FROM host_samples
      WHERE sampled_at >= NOW() - INTERVAL '7 days'
      GROUP BY 1
      ORDER BY 1 ASC
    `),
  ])
  const row = (latestRaw as unknown as Array<Record<string, unknown>>)[0]
  const latest: HostSample | null = row
    ? {
        sampled_at: Math.round(Number(row.sampled_ms)),
        disk_total_bytes: Number(row.disk_total_bytes),
        disk_available_bytes: Number(row.disk_available_bytes),
        mem_total_bytes: Number(row.mem_total_bytes),
        mem_available_bytes: Number(row.mem_available_bytes),
        cpu_count: optionalNumber(row.cpu_count),
        cpu_busy_ratio: optionalNumber(row.cpu_busy_ratio),
        load_1: optionalNumber(row.load_1),
        load_5: optionalNumber(row.load_5),
        load_15: optionalNumber(row.load_15),
        swap_total_bytes: optionalNumber(row.swap_total_bytes),
        swap_free_bytes: optionalNumber(row.swap_free_bytes),
        booted_at: row.booted_ms == null ? null : Math.round(Number(row.booted_ms)),
      }
    : null
  return {
    latest,
    series: (seriesRaw as unknown as Array<Record<string, unknown>>).map((point) => ({
      at: Math.round(Number(point.at)),
      disk_used_ratio: Number(point.disk_used_ratio),
      mem_available_ratio: Number(point.mem_available_ratio),
      cpu_busy_ratio: optionalNumber(point.cpu_busy_ratio),
    })),
  }
}

/**
 * 最近一批读数里的每个容器，配上它近 7 天的内存峰值和近 24 小时新增的 OOM 次数。
 * 看的是整台宿主机：同机的另一套部署、数据库容器也在里面，谁吃了内存一眼看得出。
 */
async function readContainers(): Promise<OpsContainers> {
  const { db } = getDbHandle()
  const rows = (await db.execute(sql`
    WITH newest AS (SELECT MAX(sampled_at) AS at FROM container_samples),
    week AS (
      SELECT container_id, MAX(mem_bytes) AS peak, MIN(oom_kills) FILTER (
        WHERE sampled_at >= NOW() - INTERVAL '24 hours'
      ) AS oom_day_ago
      FROM container_samples
      WHERE sampled_at >= NOW() - INTERVAL '7 days'
      GROUP BY container_id
    )
    SELECT
      c.container_id, c.name, c.mem_bytes, c.mem_limit_bytes, c.cpu_cores, c.oom_kills,
      EXTRACT(EPOCH FROM c.sampled_at) * 1000 AS sampled_ms,
      COALESCE(w.peak, c.mem_bytes) AS peak_mem_bytes,
      c.oom_kills - COALESCE(w.oom_day_ago, c.oom_kills) AS recent_oom_kills
    FROM container_samples c
    JOIN newest ON c.sampled_at = newest.at
    LEFT JOIN week w ON w.container_id = c.container_id
    ORDER BY c.mem_bytes DESC, c.container_id ASC
  `)) as unknown as Array<Record<string, unknown>>
  return {
    sampled_at: rows[0] ? Math.round(Number(rows[0].sampled_ms)) : null,
    containers: rows.map((row) => ({
      container_id: String(row.container_id),
      name: row.name == null ? null : String(row.name),
      mem_bytes: Number(row.mem_bytes),
      mem_limit_bytes: optionalNumber(row.mem_limit_bytes),
      cpu_cores: optionalNumber(row.cpu_cores),
      oom_kills: Number(row.oom_kills),
      peak_mem_bytes: Number(row.peak_mem_bytes),
      recent_oom_kills: Math.max(0, Number(row.recent_oom_kills)),
    })),
  }
}

/** 近 24 小时的接口统计：最近 15 分钟的合计、每 15 分钟一格的曲线、近 1 小时出错最多的路由。 */
async function readApi(): Promise<OpsApi> {
  const { db } = getDbHandle()
  const windowSeconds = OPS_THRESHOLDS.API_RECENT_WINDOW_MS / 1000
  const [recentRaw, seriesRaw, routesRaw] = await Promise.all([
    db.execute(sql`
      SELECT
        COALESCE(SUM(requests), 0) AS requests,
        COALESCE(SUM(client_errors), 0) AS client_errors,
        COALESCE(SUM(server_errors), 0) AS server_errors,
        MAX(p95_ms) AS p95_ms
      FROM api_minutes
      WHERE minute >= NOW() - make_interval(secs => ${windowSeconds})
    `),
    db.execute(sql`
      SELECT
        EXTRACT(EPOCH FROM date_bin('15 minutes', minute, TIMESTAMPTZ '2000-01-01')) * 1000 AS at,
        SUM(requests) AS requests,
        SUM(server_errors) AS server_errors,
        MAX(p95_ms) AS p95_ms
      FROM api_minutes
      WHERE minute >= NOW() - INTERVAL '24 hours'
      GROUP BY 1
      ORDER BY 1 ASC
    `),
    db.execute(sql`
      SELECT route.key AS route, SUM(route.value::int) AS count
      FROM api_minutes, jsonb_each_text(server_error_routes) AS route
      WHERE minute >= NOW() - INTERVAL '1 hour' AND server_error_routes IS NOT NULL
      GROUP BY route.key
      ORDER BY count DESC, route.key ASC
      LIMIT 5
    `),
  ])
  const recent = (recentRaw as unknown as Array<Record<string, unknown>>)[0] ?? {}
  return {
    recent: {
      requests: Number(recent.requests ?? 0),
      client_errors: Number(recent.client_errors ?? 0),
      server_errors: Number(recent.server_errors ?? 0),
      p95_ms: optionalNumber(recent.p95_ms),
    },
    window_ms: OPS_THRESHOLDS.API_RECENT_WINDOW_MS,
    series: (seriesRaw as unknown as Array<Record<string, unknown>>).map((point) => ({
      at: Math.round(Number(point.at)),
      requests: Number(point.requests),
      server_errors: Number(point.server_errors),
      p95_ms: optionalNumber(point.p95_ms),
    })),
    error_routes: (routesRaw as unknown as Array<Record<string, unknown>>).map((row) => ({
      route: String(row.route),
      count: Number(row.count),
    })),
  }
}

/** 部署日志每行：`<UTC 时间> <名字> public=<sha> private=<sha|-> image=<tag> by=<账号> result=<ok|failed>`。 */
export function parseDeploymentLog(text: string, limit = 15): OpsDeployment[] {
  const entries: OpsDeployment[] = []
  for (const line of text.split('\n').reverse()) {
    const match = /^(\S+) (\S+) public=(\S+) private=(\S+) image=(\S+) by=(\S+) result=(\S+)$/.exec(
      line.trim(),
    )
    if (!match) continue
    const at = Date.parse(match[1])
    if (!Number.isFinite(at)) continue
    entries.push({
      at,
      target: match[2],
      public_sha: match[3],
      private_sha: match[4] === '-' ? null : match[4],
      image: match[5],
      by: match[6],
      ok: match[7] === 'ok',
    })
    if (entries.length >= limit) break
  }
  return entries
}

async function readDeployments(): Promise<OpsDeployments> {
  const own = config.opsDeploymentName || null
  const path = config.opsDeploymentsLog
  const text = path ? await readFile(path, 'utf8').catch(() => '') : ''
  const entries = parseDeploymentLog(text)
  return { own, available: entries.length > 0, entries }
}

/**
 * 每个服务报所有还活着的实例，外加它最近的那一个（哪怕已经断了，看板才说得出断了多久）。
 * 发布流程会同时留着好几个实例：新的在服务，上一版在排空，更早的旧实例留给升级前开始的会话。
 * 只看最新一条心跳的话，看板会在新旧版本之间来回跳。
 */
async function readServices(): Promise<OpsServices> {
  const { db } = getDbHandle()
  const aliveSeconds = OPS_THRESHOLDS.HEARTBEAT_MAX_AGE_MS / 1000
  const rows = (await db.execute(sql`
    SELECT service, instance, version, last_seen_ms, detail
    FROM (
      SELECT
        service, instance, version, detail, last_seen_at,
        EXTRACT(EPOCH FROM last_seen_at) * 1000 AS last_seen_ms,
        ROW_NUMBER() OVER (PARTITION BY service ORDER BY last_seen_at DESC) AS freshness
      FROM service_heartbeats
      WHERE service IN ('bff', 'worker')
    ) heartbeats
    WHERE freshness = 1 OR last_seen_at >= NOW() - make_interval(secs => ${aliveSeconds})
    ORDER BY service ASC, last_seen_at DESC
  `)) as unknown as Array<Record<string, unknown>>
  return {
    services: rows.map((row) => {
      const detail = (row.detail ?? {}) as { last_successful_poll_at?: unknown }
      const polledAt = Number(detail.last_successful_poll_at)
      return {
        service: row.service as 'bff' | 'worker',
        instance: String(row.instance),
        version: String(row.version),
        last_seen_at: Math.round(Number(row.last_seen_ms)),
        last_successful_poll_at: Number.isFinite(polledAt) && polledAt > 0 ? polledAt : null,
      }
    }),
  }
}

/** 只读角色读得了大小，读不了连接状态，所以这一块只回答「盘是被什么吃掉的」。 */
async function readDatabase(): Promise<OpsDatabase> {
  const { db } = getDbHandle()
  const [sizeRaw, tablesRaw] = await Promise.all([
    db.execute(sql`SELECT pg_database_size(current_database()) AS size_bytes`),
    db.execute(sql`
      SELECT c.relname AS name, pg_total_relation_size(c.oid) AS bytes
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY bytes DESC, c.relname ASC
      LIMIT ${LARGEST_TABLE_LIMIT}
    `),
  ])
  const size = (sizeRaw as unknown as Array<Record<string, unknown>>)[0] ?? {}
  return {
    size_bytes: Number(size.size_bytes ?? 0),
    tables: (tablesRaw as unknown as Array<Record<string, unknown>>).map((row) => ({
      name: String(row.name),
      bytes: Number(row.bytes),
    })),
  }
}

/** 后端内部只读接口。只有后端够得着的现状（对象存储）经这里取，鉴权用内部令牌。 */
async function readFromBff<T>(path: string): Promise<T> {
  const token = config.auth.internalApiToken
  if (!token) throw new OpsReadError('INTERNAL_API_TOKEN 未配置，后台无法向后端取数')
  const response = await fetch(`${config.bffInternalUrl}/internal/admin/ops${path}`, {
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(BLOCK_TIMEOUT_MS),
  })
  if (!response.ok) throw new OpsReadError(`后端返回 ${response.status}`)
  return (await response.json()) as T
}

const defaultSources: OpsSources = {
  queue: readQueue,
  database: readDatabase,
  backup: () => readFromBff<OpsBackups>('/backups'),
  services: readServices,
  host: readHost,
  containers: readContainers,
  api: readApi,
  deployments: readDeployments,
}

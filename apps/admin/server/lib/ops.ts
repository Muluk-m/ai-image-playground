import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { sql } from 'drizzle-orm'
import type {
  HostSample,
  OpsBackups,
  OpsBlock,
  OpsDatabase,
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
  const [queue, database, backup, services, host] = await Promise.all([
    settle('queue', sources.queue, timeoutMs),
    settle('database', sources.database, timeoutMs),
    settle('backup', sources.backup, timeoutMs),
    settle('services', sources.services, timeoutMs),
    settle('host', sources.host, timeoutMs),
  ])
  return { generated_at: Date.now(), host, services, queue, database, backup }
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

/** 每分钟一条、留 7 天，原样给前端是一万个点；按半小时取平均后三百多个，趋势一点不少。 */
async function readHost(): Promise<OpsHost> {
  const { db } = getDbHandle()
  const [latestRaw, seriesRaw] = await Promise.all([
    db.execute(sql`
      SELECT
        EXTRACT(EPOCH FROM sampled_at) * 1000 AS sampled_ms,
        disk_total_bytes, disk_available_bytes, mem_total_bytes, mem_available_bytes
      FROM host_samples
      ORDER BY sampled_at DESC
      LIMIT 1
    `),
    db.execute(sql`
      SELECT
        EXTRACT(EPOCH FROM date_bin('30 minutes', sampled_at, TIMESTAMPTZ '2000-01-01')) * 1000 AS at,
        AVG(1 - disk_available_bytes::double precision / disk_total_bytes) AS disk_used_ratio,
        AVG(mem_available_bytes::double precision / mem_total_bytes) AS mem_available_ratio
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
      }
    : null
  return {
    latest,
    series: (seriesRaw as unknown as Array<Record<string, unknown>>).map((point) => ({
      at: Math.round(Number(point.at)),
      disk_used_ratio: Number(point.disk_used_ratio),
      mem_available_ratio: Number(point.mem_available_ratio),
    })),
  }
}

/** 重新部署会换实例；每个服务只报最新的那个，旧实例的行由 worker 清。 */
async function readServices(): Promise<OpsServices> {
  const { db } = getDbHandle()
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (service)
      service, instance, version,
      EXTRACT(EPOCH FROM last_seen_at) * 1000 AS last_seen_ms,
      detail
    FROM service_heartbeats
    WHERE service IN ('bff', 'worker')
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
}

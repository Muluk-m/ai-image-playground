import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { sql } from 'drizzle-orm'
import type { OpsBackups, OpsBlock, OpsDatabase, OpsQueue, OpsSnapshot } from '../../contracts'
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

async function settle<T>(source: () => Promise<T>): Promise<OpsBlock<T>> {
  try {
    return { ok: true, data: await source() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 各块并行取、各自失败。出事的时候恰恰最需要看其余几块，所以任何一块抛错都只落在它自己身上。
 */
export async function buildOpsSnapshot(sources: OpsSources = defaultSources): Promise<OpsSnapshot> {
  const [queue, database, backup] = await Promise.all([
    settle(sources.queue),
    settle(sources.database),
    settle(sources.backup),
  ])
  return { generated_at: Date.now(), queue, database, backup }
}

async function readQueue(): Promise<OpsQueue> {
  const { db } = getDbHandle()
  const now = Date.now()
  // 时间列在库里是 timestamptz，毫秒数只在应用边界上用：参数传 Date，读出来转回毫秒。
  const staleBefore = new Date(now - QUEUE_TIMEOUTS.STALE_IN_PROGRESS_MS)
  const [countsRaw, stuckRaw] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'queued') AS queued,
        COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress,
        EXTRACT(EPOCH FROM MIN(submitted_at) FILTER (WHERE status = 'queued')) * 1000
          AS oldest_queued_at
      FROM queue_tasks
      WHERE status IN ('queued', 'in_progress')
    `),
    db.execute(sql`
      SELECT id, model, EXTRACT(EPOCH FROM started_at) * 1000 AS started_at
      FROM queue_tasks
      WHERE status = 'in_progress' AND started_at < ${staleBefore}
      ORDER BY started_at ASC
      LIMIT ${STUCK_TASK_LIMIT}
    `),
  ])
  const counts = (countsRaw as unknown as Array<Record<string, unknown>>)[0] ?? {}
  const oldestQueuedAt =
    counts.oldest_queued_at == null ? null : Math.round(Number(counts.oldest_queued_at))
  return {
    queued: Number(counts.queued ?? 0),
    in_progress: Number(counts.in_progress ?? 0),
    oldest_queued_wait_ms: oldestQueuedAt == null ? null : Math.max(0, now - oldestQueuedAt),
    stale_after_ms: QUEUE_TIMEOUTS.STALE_IN_PROGRESS_MS,
    stuck: (stuckRaw as unknown as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      model: String(row.model),
      started_at: Math.round(Number(row.started_at)),
    })),
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
  if (!token) throw new Error('INTERNAL_API_TOKEN 未配置，后台无法向后端取数')
  const response = await fetch(`${config.bffInternalUrl}/internal/admin/ops${path}`, {
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`后端返回 ${response.status}`)
  return (await response.json()) as T
}

const defaultSources: OpsSources = {
  queue: readQueue,
  database: readDatabase,
  backup: () => readFromBff<OpsBackups>('/backups'),
}

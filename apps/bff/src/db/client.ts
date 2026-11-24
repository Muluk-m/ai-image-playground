import { createDb, type DbHandle, schema } from '@image-playground/db'
import type { SQL } from 'bun'
import { config } from '../config'

// URL-keyed lazy handles let a test file bind DATABASE_URL to its own database before its first
// query, even when an earlier file in the same Bun process already imported this module. In
// production every route shares the single pool created for the configured URL.
const handles = new Map<string, DbHandle>()
const DIRECT_HANDLE_PREFIX = 'direct:'

function resolvePooledDatabaseUrl(): string {
  return process.env.DATABASE_URL?.trim() || config.databaseUrl
}

/**
 * 直连 PostgreSQL 连接串：显式设置了 `DIRECT_DATABASE_URL` 时绕过 PgBouncer 事务连接池，
 * 供 session advisory lock（`mediaObjectLock`、`shared-maintenance`）与迁移使用；未设置时
 * 回退当前 `DATABASE_URL`。
 */
export function resolveDirectDatabaseUrl(): string {
  return (
    process.env.DIRECT_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    config.directDatabaseUrl
  )
}

function handle(): DbHandle {
  const url = resolvePooledDatabaseUrl()
  let existing = handles.get(url)
  if (!existing) {
    existing = createDb(url, config.databasePool)
    handles.set(url, existing)
  }
  return existing
}

/**
 * 直连 PostgreSQL 的 SQL 客户端。若未区分连接池与直连地址则直接复用主连接池（零额外连接）；
 * 若启用了 PgBouncer（两者地址不同），则惰性创建小容量直连池并在 `close()` 时一并回收。
 */
export function directSql(): SQL {
  const directUrl = resolveDirectDatabaseUrl()
  if (directUrl === resolvePooledDatabaseUrl()) return handle().client
  const key = `${DIRECT_HANDLE_PREFIX}${directUrl}`
  let existing = handles.get(key)
  if (!existing) {
    const applicationName = config.databasePool.applicationName
      ? `${config.databasePool.applicationName}-direct`
      : undefined
    existing = createDb(directUrl, {
      ...config.databasePool,
      max: Math.min(config.databasePool.max ?? 4, 2),
      ...(applicationName ? { applicationName } : {}),
    })
    handles.set(key, existing)
  }
  return existing.client
}

/** Forwards every Drizzle call to the handle that matches the current DATABASE_URL. */
export const db: DbHandle['db'] = new Proxy({} as DbHandle['db'], {
  get(_target, property) {
    const target = handle().db as unknown as Record<PropertyKey, unknown>
    const value = target[property]
    // Bun SQL is callable but also owns reserve/begin; binding it discards those methods.
    return property !== '$client' && typeof value === 'function' ? value.bind(target) : value
  },
})

/** Closes every pool this process opened (both pooled and direct). */
export async function close(): Promise<void> {
  const open = [...handles.values()]
  handles.clear()
  await Promise.all(open.map((entry) => entry.close()))
}

export { schema }

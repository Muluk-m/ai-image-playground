import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import * as schema from './schema'

export interface CreateDbOptions {
  /** 设 true 时打开 PRAGMA query_only=ON，所有 INSERT/UPDATE/DELETE 抛错。 */
  readonly?: boolean
}

/**
 * Drizzle client 工厂。
 * - 任何模式都开 WAL（多进程读 + 单进程写安全）
 * - readonly 模式额外 query_only=ON，admin 进程用此模式确保不会误写
 */
export function createDb(databaseUrl: string, options: CreateDbOptions = {}) {
  const sqlite = new Database(databaseUrl)
  sqlite.exec('PRAGMA journal_mode = WAL;')
  if (options.readonly) {
    sqlite.exec('PRAGMA query_only = ON;')
  }
  const db = drizzle(sqlite, { schema })
  const checkpointWal = () => {
    try {
      sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    } catch {
      /* ignore */
    }
  }
  return { db, schema, checkpointWal, sqlite }
}

export { schema }

import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import * as schema from './schema'

/**
 * Drizzle client 工厂。Task 2 会扩展支持 readonly + WAL pragma 收敛。
 * 当前仅 wrap Database 暴露 `db` + `schema` + `checkpointWal`。
 */
export function createDb(databaseUrl: string) {
  const sqlite = new Database(databaseUrl)
  sqlite.exec('PRAGMA journal_mode = WAL;')
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

import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { config } from '../config'
import * as schema from './schema'

const sqlite = new Database(config.databaseUrl)
sqlite.exec('PRAGMA journal_mode = WAL;')

export const db = drizzle(sqlite, { schema })
export { schema }

/** 关停前把 WAL 合并回主库，防止 -wal 文件跨进程重启越积越大。失败不阻断退出。 */
export function checkpointWal(): void {
  try {
    sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  } catch {
    /* ignore */
  }
}

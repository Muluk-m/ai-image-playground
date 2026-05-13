import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { config } from '../config'
import * as schema from './schema'

const sqlite = new Database(config.databaseUrl)
sqlite.exec('PRAGMA journal_mode = WAL;')

export const db = drizzle(sqlite, { schema })
// 底层 sqlite 句柄给维护类操作用（drizzle 的 .run() 在 bun-sqlite 不返回
// changes 计数；需要计数时直接用 sqlite.prepare(...).run() 拿 result.changes）。
export { schema, sqlite }

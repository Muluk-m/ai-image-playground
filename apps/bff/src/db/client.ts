import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { config } from '../config'
import * as schema from './schema'

const sqlite = new Database(config.databaseUrl)
sqlite.exec('PRAGMA journal_mode = WAL;')

export const db = drizzle(sqlite, { schema })
export { schema }

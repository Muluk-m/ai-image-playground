import { SQL } from 'bun'
import { type BunSQLDatabase, drizzle } from 'drizzle-orm/bun-sql'
import * as schema from './schema'
export interface DbHandle {
  db: BunSQLDatabase<typeof schema> & { $client: SQL }
  schema: typeof schema
  client: SQL
  close(): Promise<void>
}

/**
 * Creates a PostgreSQL pool and its typed Drizzle client. Call close() during process shutdown or
 * after short-lived test/administrative use.
 */
export function createDb(databaseUrl: string): DbHandle {
  const client = new SQL(databaseUrl)
  const db = drizzle(client, { schema })
  return {
    db,
    schema,
    client,
    close: () => client.close(),
  }
}

export { schema }

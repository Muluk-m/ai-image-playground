import { SQL } from 'bun'
import { type BunSQLDatabase, drizzle } from 'drizzle-orm/bun-sql'
import * as schema from './schema'
export interface DbHandle {
  db: BunSQLDatabase<typeof schema> & { $client: SQL }
  schema: typeof schema
  client: SQL
  close(): Promise<void>
}

/** Pool limits handed to Bun's SQL driver; both timeouts are in seconds, 0 disables them. */
export interface DbPoolOptions {
  /** Connections this process may open at once. Bun queues further queries until one frees up. */
  max?: number
  /** Closes a connection after this long without traffic. */
  idleTimeout?: number
  /** Closes a connection this long after it was opened. */
  maxLifetime?: number
}

/**
 * Without an idle timeout every process keeps its peak connection count forever, and the
 * deployments sharing one PostgreSQL run out of max_connections on the next rollout. Bun's timeout
 * also cuts a statement or transaction that stays silent this long, so it must exceed any single
 * wait the application makes. No lifetime cap by default: Bun enforces it even mid-transaction.
 */
const DEFAULT_IDLE_TIMEOUT_SECONDS = 30

/**
 * Creates a PostgreSQL pool and its typed Drizzle client. Call close() during process shutdown or
 * after short-lived test/administrative use.
 */
export function createDb(databaseUrl: string, pool: DbPoolOptions = {}): DbHandle {
  const client = new SQL(databaseUrl, {
    max: pool.max,
    idleTimeout: pool.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_SECONDS,
    maxLifetime: pool.maxLifetime,
  })
  const db = drizzle(client, { schema })
  return {
    db,
    schema,
    client,
    close: () => client.close(),
  }
}

/**
 * Per-process pool size from DATABASE_POOL_MAX. Unset keeps the driver default; anything but a
 * positive integer throws so a typo stops the process at startup instead of silently using 10.
 */
export function databasePoolMaxFromEnv(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = env.DATABASE_POOL_MAX?.trim()
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('DATABASE_POOL_MAX must be a positive integer')
  }
  return value
}

export { schema }

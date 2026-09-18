import { SQL } from 'bun'
import { type BunSQLDatabase, drizzle } from 'drizzle-orm/bun-sql'
import * as schema from './schema'
export interface DbHandle {
  db: BunSQLDatabase<typeof schema> & { $client: SQL }
  schema: typeof schema
  client: SQL
  close(): Promise<void>
}

/** Pool settings handed to Bun's SQL driver; both timeouts are in seconds, 0 disables them. */
export interface DbPoolOptions {
  /** Connections this process may open at once. Bun queues further queries until one frees up. */
  max?: number
  /**
   * Closes a connection after this long without traffic. Bun also cuts a statement or transaction
   * that stays silent this long, so only long-running services opt in, well above any single wait.
   */
  idleTimeout?: number
  /** Closes a connection this long after it was opened, even mid-transaction. */
  maxLifetime?: number
  /** Shown as application_name in pg_stat_activity, so connections can be told apart by role. */
  applicationName?: string
}

/**
 * Creates a PostgreSQL pool and its typed Drizzle client. Call close() during process shutdown or
 * after short-lived test/administrative use. Unset options keep Bun's defaults: 10 connections,
 * kept open indefinitely.
 */
export function createDb(databaseUrl: string, pool: DbPoolOptions = {}): DbHandle {
  const client = new SQL(databaseUrl, {
    max: pool.max,
    idleTimeout: pool.idleTimeout,
    maxLifetime: pool.maxLifetime,
    connection: pool.applicationName ? { application_name: pool.applicationName } : undefined,
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
 * Without an idle timeout a long-running process keeps its peak connection count forever, and the
 * deployments sharing one PostgreSQL run out of max_connections on the next rollout.
 */
const SERVICE_IDLE_TIMEOUT_SECONDS = 60

const positiveIntegerEnv = (env: Record<string, string | undefined>, name: string) => {
  const raw = env[name]?.trim()
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

/**
 * Pool settings for a long-running service: DATABASE_POOL_MAX (unset keeps the driver's 10) and
 * DATABASE_IDLE_TIMEOUT_SECONDS (default 60). Anything but a positive integer throws, so a typo
 * stops the process at startup instead of silently falling back.
 */
export function databasePoolFromEnv(
  applicationName: string,
  env: Record<string, string | undefined> = process.env,
): DbPoolOptions {
  return {
    applicationName,
    max: positiveIntegerEnv(env, 'DATABASE_POOL_MAX'),
    idleTimeout:
      positiveIntegerEnv(env, 'DATABASE_IDLE_TIMEOUT_SECONDS') ?? SERVICE_IDLE_TIMEOUT_SECONDS,
  }
}

export { schema }

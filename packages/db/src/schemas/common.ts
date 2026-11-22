import { sql } from 'drizzle-orm'
import { customType, text } from 'drizzle-orm/pg-core'

/**
 * HTTP and queue contracts use Unix epoch milliseconds. PostgreSQL stores timestamptz so expiry,
 * retention, and operational queries remain timezone-safe.
 */
export const epochMs = customType<{ data: number; driverData: string }>({
  dataType: () => 'timestamp with time zone',
  toDriver: (value) => new Date(value).toISOString(),
  fromDriver: (value) => new Date(value).getTime(),
})
/**
 * Bun SQL accepts and returns JSON values as objects. Drizzle's built-in pg jsonb mapper serializes
 * values first, which would store a JSON string instead of a JSON object with this driver.
 */
export const bunJsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => 'jsonb',
  toDriver: (value) => value,
  fromDriver: (value) => value,
})

/**
 * Override values include primitives, which Bun otherwise binds as SQL booleans/numbers. Bind the
 * serialized JSON as text before casting so PostgreSQL stores JSON scalars, not JSON strings.
 */
export const operatorOverrideJsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => 'jsonb',
  toDriver: (value) => sql`${JSON.stringify(value)}::text::jsonb`,
  fromDriver: (value) => value,
})

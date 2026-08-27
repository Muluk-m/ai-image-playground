import { isPostgresUrl } from '@image-playground/db'
import { sql } from 'drizzle-orm'

export function isAdminPostgres(): boolean {
  const url = process.env.DATABASE_URL?.trim() ?? ''
  return isPostgresUrl(url)
}

export function modelsAggregateSql() {
  return isAdminPostgres()
    ? sql`string_agg(DISTINCT t.model, ',')`
    : sql`GROUP_CONCAT(DISTINCT t.model)`
}

import type { SQL } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { createDb } from './client'
import { isPostgresUrl } from './open-persistence'

export interface AdminRead {
  all(query: SQL): Promise<Record<string, unknown>[]>
}

function rowsFromExecute(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && 'rows' in result) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return Array.from(result as Iterable<Record<string, unknown>>)
}

export function adminReadFromExecute(execute: (query: SQL) => Promise<unknown>): AdminRead {
  return {
    async all(query) {
      return rowsFromExecute(await execute(query))
    },
  }
}

export async function openAdminRead(databaseUrl: string): Promise<AdminRead> {
  if (isPostgresUrl(databaseUrl)) {
    const client = postgres(databaseUrl, { max: 4 })
    await client.unsafe('SET default_transaction_read_only = on')
    const db = drizzle(client)
    return adminReadFromExecute((query) => db.execute(query))
  }

  const { db } = createDb(databaseUrl, { readonly: true })
  return {
    async all(query) {
      return db.all(query) as Record<string, unknown>[]
    },
  }
}

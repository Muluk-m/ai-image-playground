import { createDb, type DbHandle, schema } from '@image-playground/db'
import { config } from '../config'

// URL-keyed lazy handles let a test file bind DATABASE_URL to its own database before its first
// query, even when an earlier file in the same Bun process already imported this module. In
// production every route shares the single pool created for the configured URL.
const handles = new Map<string, DbHandle>()

function handle(): DbHandle {
  const url = process.env.DATABASE_URL?.trim() || config.databaseUrl
  let existing = handles.get(url)
  if (!existing) {
    existing = createDb(url)
    handles.set(url, existing)
  }
  return existing
}

/** Forwards every Drizzle call to the handle that matches the current DATABASE_URL. */
export const db: DbHandle['db'] = new Proxy({} as DbHandle['db'], {
  get(_target, property) {
    const target = handle().db as unknown as Record<PropertyKey, unknown>
    const value = target[property]
    return typeof value === 'function' ? value.bind(target) : value
  },
})

/** Closes every pool this process opened. */
export async function close(): Promise<void> {
  const open = [...handles.values()]
  handles.clear()
  await Promise.all(open.map((entry) => entry.close()))
}

export { schema }

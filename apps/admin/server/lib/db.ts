import { createDb, type DbHandle } from '@image-playground/db'
import { config } from '../config'

// URL-keyed lazy handles let tests replace DATABASE_URL before their first query while production
// shares one Bun SQL pool across every Admin route.
const handles = new Map<string, DbHandle>()

export function getDbHandle(): DbHandle {
  const url = process.env.DATABASE_URL?.trim() || config.databaseUrl
  let handle = handles.get(url)
  if (!handle) {
    handle = createDb(url)
    handles.set(url, handle)
  }
  return handle
}

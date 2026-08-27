import { type AdminRead, openAdminRead } from '@image-playground/db'
import { config } from '../config'

let testingOverride: AdminRead | null = null
const handles = new Map<string, Promise<AdminRead>>()

export function setAdminReadForTesting(handle: AdminRead | null): void {
  testingOverride = handle
  handles.clear()
}

export function getAdminRead(): Promise<AdminRead> {
  if (testingOverride) return Promise.resolve(testingOverride)
  const url = process.env.DATABASE_URL?.trim() || config.databaseUrl
  let pending = handles.get(url)
  if (!pending) {
    pending = openAdminRead(url)
    handles.set(url, pending)
  }
  return pending
}

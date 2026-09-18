import { AsyncLocalStorage } from 'node:async_hooks'
import * as schema from '@image-playground/db'
import { and, eq, gt, type SQL } from 'drizzle-orm'

export const TASK_LEASE_MS = 60_000
export const TASK_HEARTBEAT_MS = 10_000
export const executionContext = new AsyncLocalStorage<string>()

/** A stale executor may finish a fetch, but can no longer publish or settle its result. */
export function executionFence(): SQL | undefined {
  const token = executionContext.getStore()
  return token
    ? and(eq(schema.tasks.execution_token, token), gt(schema.tasks.lease_expires_at, Date.now()))
    : undefined
}

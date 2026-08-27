import { createPostgresPersistence } from './pg-persistence'
import { createSqlitePersistence } from './sqlite-persistence'
import type { QueuePersistence } from './stores'

export function isPostgresUrl(databaseUrl: string): boolean {
  return /^postgres(ql)?:\/\//.test(databaseUrl)
}

export async function openPersistence(databaseUrl: string): Promise<QueuePersistence> {
  if (isPostgresUrl(databaseUrl)) {
    return createPostgresPersistence(databaseUrl)
  }
  return createSqlitePersistence(databaseUrl)
}

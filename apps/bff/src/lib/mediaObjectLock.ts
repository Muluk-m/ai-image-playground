import { type BunSQLDatabase, drizzle } from 'drizzle-orm/bun-sql'
import { directSql, schema } from '../db/client'

/**
 * Object I/O and reclamation share a session advisory lock, without holding a transaction or owner row.
 * Uses `directSql()` so lock/unlock always stay on the same PostgreSQL backend session even when
 * `DATABASE_URL` routes regular traffic through PgBouncer transaction pooling.
 */
export async function withMediaObjectLock<T>(
  mediaId: string,
  work: (database: BunSQLDatabase<typeof schema>) => Promise<T>,
): Promise<T | undefined> {
  const connection = await directSql().reserve()
  const identity = `attachment-media:${mediaId}`
  let locked = false
  try {
    const [lock] =
      await connection`SELECT pg_try_advisory_lock(hashtextextended(${identity}, 0)) AS locked`
    locked = lock?.locked === true
    if (!locked) return undefined
    return await work(drizzle(connection, { schema }))
  } finally {
    try {
      if (locked) await connection`SELECT pg_advisory_unlock(hashtextextended(${identity}, 0))`
    } finally {
      connection.release()
    }
  }
}

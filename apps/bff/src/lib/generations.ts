import type { GenerationDetail, GenerationPage } from '@image-playground/shared'
import { and, desc, eq, lt, or, sql } from 'drizzle-orm'
import { db, schema } from '../db/client'

const table = schema.generation_records
const columns = {
  id: table.id,
  provider: table.provider,
  model: table.model,
  status: table.status,
  createdAt: table.created_at,
  startedAt: table.started_at,
  completedAt: table.completed_at,
  revision: sql<string>`${table.revision}::text`,
}
export type GenerationCursor = { createdAt: number; id: string }
export async function listGenerations(
  userId: string,
  limit: number,
  cursor?: GenerationCursor,
): Promise<GenerationPage> {
  const rows = await db
    .select(columns)
    .from(table)
    .where(
      and(
        eq(table.user_id, userId),
        cursor
          ? or(
              lt(table.created_at, cursor.createdAt),
              and(eq(table.created_at, cursor.createdAt), lt(table.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(table.created_at), desc(table.id))
    .limit(limit + 1)
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString(
            'base64url',
          )
        : null,
  }
}
export async function readGeneration(
  userId: string,
  id: string,
): Promise<GenerationDetail | undefined> {
  const [record] = await db
    .select({ ...columns, prompt: table.prompt })
    .from(table)
    .where(and(eq(table.user_id, userId), eq(table.id, id)))
  return record
}

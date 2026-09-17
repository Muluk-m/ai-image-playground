import type { GenerationDetail, GenerationPage } from '@image-playground/shared'
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm'
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
  const selected = rows.slice(0, limit)
  const covers = selected.length
    ? await db
        .select({
          generationId: schema.generation_images.generation_id,
          index: schema.generation_images.position,
          mediaId: schema.media_objects.id,
          width: schema.media_objects.width,
          height: schema.media_objects.height,
          contentType: schema.media_objects.content_type,
        })
        .from(schema.generation_images)
        .innerJoin(
          schema.media_objects,
          eq(schema.generation_images.media_id, schema.media_objects.id),
        )
        .where(
          and(
            inArray(
              schema.generation_images.generation_id,
              selected.map((row) => row.id),
            ),
            eq(schema.generation_images.role, 'output'),
            eq(schema.generation_images.position, 0),
            eq(schema.media_objects.user_id, userId),
          ),
        )
    : []
  const byId = new Map(covers.map(({ generationId, ...cover }) => [generationId, cover]))
  const items = selected.map((row) => ({ ...row, cover: byId.get(row.id) ?? null }))
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
    .select({
      ...columns,
      prompt: table.prompt,
      parameters: table.parameters,
      actualParameters: table.actual_parameters,
    })
    .from(table)
    .where(and(eq(table.user_id, userId), eq(table.id, id)))
  if (!record) return undefined
  const images = await db
    .select({
      role: schema.generation_images.role,
      index: schema.generation_images.position,
      mediaId: schema.media_objects.id,
      width: schema.media_objects.width,
      height: schema.media_objects.height,
      contentType: schema.media_objects.content_type,
    })
    .from(schema.generation_images)
    .innerJoin(schema.media_objects, eq(schema.generation_images.media_id, schema.media_objects.id))
    .where(
      and(eq(schema.generation_images.generation_id, id), eq(schema.media_objects.user_id, userId)),
    )
    .orderBy(schema.generation_images.position)
  const byRole = (role: 'input' | 'mask' | 'output') =>
    images.filter((image) => image.role === role).map(({ role: _role, ...image }) => image)
  return {
    ...record,
    outputs: byRole('output'),
    cover: byRole('output')[0] ?? null,
    inputs: byRole('input'),
    mask: byRole('mask')[0] ?? null,
  }
}

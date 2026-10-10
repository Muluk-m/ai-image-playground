import type { AgentMediaReference } from '@image-playground/shared'
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import { AgentToolError } from './tools/errors'

interface ImageLookup {
  readonly conversationId: string
  readonly userId: string
  readonly imageIds?: readonly string[]
  readonly query?: string
  readonly cursor?: string
  readonly limit?: number
}

/** One catalog backs discovery and durable resolution; attachments shadow generated aliases. */
export async function findConversationImages(input: ImageLookup) {
  if (input.imageIds?.length === 0) return []
  const attachmentFilter = input.imageIds
    ? sql`AND ref.value->>'imageId' IN ${input.imageIds}`
    : sql``
  const generatedFilter = input.imageIds
    ? sql`AND ('agent_' || g.id || '_' || gi.position) IN ${input.imageIds}`
    : sql``
  const catalog = sql`(
    WITH owned_conversation AS (
      SELECT id FROM agent_conversations
      WHERE id = ${input.conversationId} AND user_id = ${input.userId} AND deleted_at IS NULL
    ), attachments AS (
      SELECT DISTINCT ON (ref.value->>'imageId')
        ref.value->>'imageId' AS image_id, ref.value->>'mediaId' AS media_id,
        ref.value->>'name' AS name, m.created_at, m.turn_id, m.id AS message_id,
        left(block.value->>'text', 1000) AS prompt
      FROM agent_messages m
      JOIN owned_conversation c ON c.id = m.conversation_id
      CROSS JOIN LATERAL jsonb_array_elements(m.content) WITH ORDINALITY block(value, position)
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(block.value->'references') = 'array'
          THEN block.value->'references' ELSE '[]'::jsonb END
      ) WITH ORDINALITY ref(value, position)
      WHERE m.role = 'user' AND m.deleted_at IS NULL AND block.value->>'type' = 'text'
        ${attachmentFilter}
      ORDER BY ref.value->>'imageId', m.seq DESC, block.position DESC, ref.position DESC
    )
    SELECT a.image_id, a.name, a.created_at, a.turn_id, a.message_id, a.prompt,
      'attachment' AS source, m.width, m.height,
      CASE WHEN m.status = 'ready' AND m.object_key IS NOT NULL
        AND m.content_type LIKE 'image/%'
        AND EXISTS (SELECT 1 FROM media_references r WHERE r.user_id = ${input.userId}
          AND r.media_id = m.id AND r.owner_kind = 'conversation' AND r.owner_id = ${input.conversationId})
        THEN jsonb_strip_nulls(jsonb_build_object('imageId', a.image_id, 'mediaId', m.id, 'name', a.name))
        ELSE NULL END AS reference
    FROM attachments a
    LEFT JOIN media_objects m ON m.id = a.media_id AND m.user_id = ${input.userId}
    UNION ALL
    SELECT ('agent_' || g.id || '_' || gi.position) AS image_id,
      NULL AS name, g.created_at, g.source->>'turnId' AS turn_id, NULL AS message_id,
      left(g.prompt, 1000) AS prompt, 'generation' AS source, m.width, m.height,
      CASE WHEN g.status = 'completed' AND m.status = 'ready' AND m.object_key IS NOT NULL
        THEN jsonb_build_object('imageId', 'agent_' || g.id || '_' || gi.position, 'mediaId', m.id)
        ELSE NULL END AS reference
    FROM generation_records g
    JOIN owned_conversation c ON c.id = g.source->>'conversationId'
    JOIN generation_images gi ON gi.generation_id = g.id AND gi.role = 'output'
    JOIN media_objects m ON m.id = gi.media_id AND m.user_id = ${input.userId}
    WHERE g.user_id = ${input.userId} AND g.deleted_at IS NULL
      AND g.source->>'kind' = 'agent' AND m.content_type LIKE 'image/%'
      ${generatedFilter}
      AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.image_id = 'agent_' || g.id || '_' || gi.position)
  ) AS conversation_images`
  const imageId = sql<string>`image_id COLLATE "C"`
  const createdAt = sql<number>`(extract(epoch FROM created_at) * 1000)::bigint`.mapWith(Number)
  let after: [number, string] | undefined
  if (input.cursor) {
    try {
      const value: unknown = JSON.parse(Buffer.from(input.cursor, 'base64url').toString())
      if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        !Number.isSafeInteger(value[0]) ||
        typeof value[1] !== 'string'
      )
        throw new Error('cursor')
      after = [value[0], value[1]]
    } catch {
      throw new AgentToolError('invalid_params', '图片目录的翻页标记无效，请重新查询。')
    }
  }
  const query = input.query?.trim()
  return db
    .select({
      imageId,
      createdAt,
      source: sql<'attachment' | 'generation'>`source`,
      turnId: sql<string>`turn_id`,
      messageId: sql<string | null>`message_id`,
      name: sql<string | null>`left(name, 200)`,
      prompt: sql<string>`coalesce(prompt, '')`,
      width: sql<number | null>`width`,
      height: sql<number | null>`height`,
      reference: sql<AgentMediaReference | null>`reference`,
    })
    .from(catalog)
    .where(
      and(
        input.imageIds ? inArray(imageId, [...input.imageIds]) : undefined,
        query ? or(ilike(sql`name`, `%${query}%`), ilike(sql`prompt`, `%${query}%`)) : undefined,
        after ? sql`(${createdAt}, ${imageId}) < (${after[0]}, ${after[1]})` : undefined,
      ),
    )
    .orderBy(desc(createdAt), desc(imageId))
    .limit(input.limit === undefined ? 10_000 : input.limit + 1)
}

export async function readConversationImageCatalog(
  input: ImageLookup & { readonly limit: number },
) {
  const rows = await findConversationImages(input)
  const selected = rows.slice(0, input.limit)
  const last = selected.at(-1)
  return {
    images: selected.map(({ reference, ...image }) => ({
      ...image,
      available: reference !== null,
    })),
    nextCursor:
      rows.length > input.limit && last
        ? Buffer.from(JSON.stringify([last.createdAt, last.imageId])).toString('base64url')
        : null,
  }
}

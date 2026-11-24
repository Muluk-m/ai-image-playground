import type { ProjectDocument } from '@image-playground/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../../db/client'

/**
 * 按登录用户与会话归属定位未删除的云端画布项目。
 * 会话与项目是一对一的（`idx_canvas_projects_conversation`），多限定 `user_id` 防止跨用户误读。
 */
export async function findCanvasProjectByConversation(
  userId: string,
  conversationId: string,
): Promise<{ id: string } | null> {
  const [project] = await db
    .select({ id: schema.canvas_projects.id })
    .from(schema.canvas_projects)
    .where(
      and(
        eq(schema.canvas_projects.user_id, userId),
        eq(schema.canvas_projects.conversation_id, conversationId),
        isNull(schema.canvas_projects.deleted_at),
      ),
    )
    .limit(1)
  return project ?? null
}

/**
 * 读取登录用户在当前会话下未删除的画布文档快照与修订号。
 */
export async function loadCanvasProjectDocument(
  userId: string,
  conversationId: string,
): Promise<{ document: ProjectDocument; revision: number } | null> {
  const [row] = await db
    .select({
      document: schema.canvas_projects.document,
      revision: schema.canvas_projects.revision,
    })
    .from(schema.canvas_projects)
    .where(
      and(
        eq(schema.canvas_projects.conversation_id, conversationId),
        eq(schema.canvas_projects.user_id, userId),
        isNull(schema.canvas_projects.deleted_at),
      ),
    )
    .limit(1)
  return row?.document ? { document: row.document, revision: row.revision } : null
}

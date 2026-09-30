import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../../db/client'

/** 项目入口是服务端的权威来源；匿名/尚未同步的项目沿用最近一次发话的画布快照。 */
export async function loadAgentExperience(
  conversationId: string,
  userId: string | null,
): Promise<'chat' | 'canvas'> {
  if (userId) {
    const [project] = await db
      .select({ document: schema.canvas_projects.document })
      .from(schema.canvas_projects)
      .where(
        and(
          eq(schema.canvas_projects.conversation_id, conversationId),
          eq(schema.canvas_projects.user_id, userId),
          isNull(schema.canvas_projects.deleted_at),
        ),
      )
      .limit(1)
    // 老会话项目与客户端 projectExperience 一样默认进入 chat。
    if (project) return project.document.experience ?? 'chat'
  }
  const [message] = await db
    .select({ payload: schema.agent_inbox.payload })
    .from(schema.agent_inbox)
    .where(
      and(
        eq(schema.agent_inbox.conversation_id, conversationId),
        inArray(schema.agent_inbox.kind, ['user_message', 'clarification_answer']),
      ),
    )
    .orderBy(desc(schema.agent_inbox.seq))
    .limit(1)
  return message && 'canvas' in message.payload && message.payload.canvas ? 'canvas' : 'chat'
}

import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import type { AgentTurnSource } from './turn-preparation'

/** 项目入口是权威来源；无云项目时，只认当前消息或原轮已消费的消息。 */
export async function loadAgentExperience(
  conversationId: string,
  userId: string | null,
  source: AgentTurnSource,
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
  if (source.kind === 'message') return source.message.canvas ? 'canvas' : 'chat'
  if (source.kind === 'resume' && source.resume.canvas) return 'canvas'
  const originTurnId =
    source.kind === 'wake'
      ? source.wake.turnId
      : (source.resume.wake?.turnId ?? source.resume.interruptedTurnId)
  const [message] = await db
    .select({ payload: schema.agent_inbox.payload })
    .from(schema.agent_inbox)
    .where(
      and(
        eq(schema.agent_inbox.conversation_id, conversationId),
        eq(schema.agent_inbox.status, 'consumed'),
        eq(schema.agent_inbox.consumed_turn_id, originTurnId),
        inArray(schema.agent_inbox.kind, ['user_message', 'clarification_answer']),
      ),
    )
    .orderBy(desc(schema.agent_inbox.seq))
    .limit(1)
  return message && 'canvas' in message.payload && message.payload.canvas ? 'canvas' : 'chat'
}

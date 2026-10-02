import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import type { AgentTurnSource } from './turn-preparation'

type AgentExperience = 'chat' | 'canvas'

/**
 * 项目文档记下的入口是权威来源；没记下时只认当前消息或原轮已消费的消息。
 *
 * 文档缺 `experience` 的是这个字段出现之前建的项目。客户端按「绑会话之前、有内容就是画布」
 * 推断它，绑上会话的那一刻推断就失效了，所以服务端不能照抄那条规则补默认值——那样画布里
 * 发出的第一句话会被当成对话，模型拿不到画布工具。客户端在画布视图里发话才带画布快照，
 * 这就是它当时看到的入口；第一次由用户消息判定出来，就记到项目上，之后两边都以它为准。
 */
export async function loadAgentExperience(
  conversationId: string,
  userId: string | null,
  source: AgentTurnSource,
): Promise<AgentExperience> {
  const owned = userId
    ? and(
        eq(schema.canvas_projects.conversation_id, conversationId),
        eq(schema.canvas_projects.user_id, userId),
        isNull(schema.canvas_projects.deleted_at),
      )
    : undefined
  if (owned) {
    const [project] = await db
      .select({ document: schema.canvas_projects.document })
      .from(schema.canvas_projects)
      .where(owned)
      .limit(1)
    if (project?.document.experience) return project.document.experience
    if (project && source.kind === 'message') {
      const experience = source.message.canvas ? 'canvas' : 'chat'
      // 只补空着的那格，不动 revision：客户端保存时沿用已有的值（见 `lib/projects.ts`），
      // 项目目录摘要会把它带回客户端。
      await db
        .update(schema.canvas_projects)
        .set({
          document: sql`jsonb_set(${schema.canvas_projects.document}, '{experience}', to_jsonb(${experience}::text))`,
        })
        .where(and(owned, sql`${schema.canvas_projects.document}->>'experience' IS NULL`))
      return experience
    }
  }
  if (source.kind === 'message') return source.message.canvas ? 'canvas' : 'chat'
  if (source.kind === 'resume' && source.resume.canvas) return 'canvas'
  let originTurnId =
    source.kind === 'wake'
      ? source.wake.turnId
      : (source.resume.wake?.turnId ?? source.resume.interruptedTurnId)
  const visited = new Set<string>()
  // 任务可能由上一轮唤醒里的后续编辑提交；沿已消费的来源追到用户消息，不能读队尾。
  while (!visited.has(originTurnId)) {
    visited.add(originTurnId)
    const rows = await db
      .select({ payload: schema.agent_inbox.payload })
      .from(schema.agent_inbox)
      .where(
        and(
          eq(schema.agent_inbox.conversation_id, conversationId),
          eq(schema.agent_inbox.status, 'consumed'),
          eq(schema.agent_inbox.consumed_turn_id, originTurnId),
        ),
      )
      .orderBy(desc(schema.agent_inbox.seq))
    const origin = rows.find((row) => 'text' in row.payload) ?? rows[0]
    if (!origin) break
    const payload = origin.payload
    if ('canvas' in payload && payload.canvas) return 'canvas'
    if ('text' in payload) return 'chat'
    if ('interruptedTurnId' in payload)
      originTurnId = payload.wake?.turnId ?? payload.interruptedTurnId
    else originTurnId = payload.turnId
  }
  return 'chat'
}

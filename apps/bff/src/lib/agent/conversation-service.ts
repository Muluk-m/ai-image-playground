import { and, asc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { cancelAgentConversationJobs } from './background-jobs'
import { discardConversationBatchDrafts } from './batch-plans'
import { detachConversationBatches } from './batch-progress'
import { lockConversation } from './confirmations'
import { type AgentOwner, softDeleteAgentConversation } from './conversations'

export async function listConversationBatches(
  userId: string,
  conversationId: string,
): Promise<Array<{ id: string }> | null> {
  const [conversation] = await db
    .select({ id: schema.agent_conversations.id })
    .from(schema.agent_conversations)
    .where(
      and(
        eq(schema.agent_conversations.id, conversationId),
        eq(schema.agent_conversations.user_id, userId),
        isNull(schema.agent_conversations.deleted_at),
      ),
    )
  if (!conversation) return null
  return db
    .select({ id: schema.agent_batches.id })
    .from(schema.agent_batches)
    .where(
      and(
        eq(schema.agent_batches.user_id, userId),
        eq(schema.agent_batches.conversation_id, conversationId),
      ),
    )
    .orderBy(asc(schema.agent_batches.created_at), asc(schema.agent_batches.id))
}

export async function readUserMessageContent(conversationId: string, messageId: string) {
  const [message] = await db
    .select({ content: schema.agent_messages.content })
    .from(schema.agent_messages)
    .where(
      and(
        eq(schema.agent_messages.id, messageId),
        eq(schema.agent_messages.conversation_id, conversationId),
        eq(schema.agent_messages.role, 'user'),
        isNull(schema.agent_messages.deleted_at),
      ),
    )
    .limit(1)
  return message?.content ?? null
}

export async function findUserMessageId(
  conversationId: string,
  messageId: string,
): Promise<string | null> {
  const [existing] = await db
    .select({ id: schema.agent_messages.id })
    .from(schema.agent_messages)
    .where(
      and(
        eq(schema.agent_messages.conversation_id, conversationId),
        eq(schema.agent_messages.id, messageId),
        eq(schema.agent_messages.role, 'user'),
      ),
    )
    .limit(1)
  return existing?.id ?? null
}

export async function isConversationBoundToCanvasProject(
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const [project] = await db
    .select({ id: schema.canvas_projects.id })
    .from(schema.canvas_projects)
    .where(
      and(
        eq(schema.canvas_projects.user_id, userId),
        eq(schema.canvas_projects.conversation_id, conversationId),
      ),
    )
    .limit(1)
  return Boolean(project)
}

/**
 * 删除与确认生成走同一把会话锁：确认不会把任务建进一个刚删掉的会话，
 * 墓碑与取消也同一次提交，没有「删完又冒出一条任务」的缝。
 */
export async function deleteAgentConversationCascade(
  conversationId: string,
  owner: AgentOwner,
): Promise<void> {
  const postCommitHooks: Array<() => Promise<void>> = []
  await db.transaction(async (tx) => {
    await lockConversation(tx, conversationId, owner.kind === 'user' ? owner.userId : null)
    await discardConversationBatchDrafts(conversationId, tx)
    await softDeleteAgentConversation(conversationId, owner, tx)
    await detachConversationBatches(conversationId, tx)
    // 删掉的会话不该接着花钱：没结束的后台任务一并取消，按原桶退回。
    await cancelAgentConversationJobs(conversationId, {
      tx,
      onCommit: (hook) => postCommitHooks.push(hook),
    })
  })
  for (const hook of postCommitHooks) await hook()
}

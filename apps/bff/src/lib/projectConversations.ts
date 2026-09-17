import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { createAgentConversation, findAgentConversation } from './agent/conversations'

export async function ensureProjectConversation(
  userId: string,
  projectId: string,
  conversationId?: string,
) {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .for('update')
    const [project] = await tx
      .select({
        id: schema.canvas_projects.id,
        conversationId: schema.canvas_projects.conversation_id,
      })
      .from(schema.canvas_projects)
      .where(
        and(eq(schema.canvas_projects.id, projectId), eq(schema.canvas_projects.user_id, userId)),
      )
    if (!project) return { ok: false as const, status: 404 as const, error: 'project_not_found' }
    const owner = { kind: 'user' as const, userId }
    if (project.conversationId) {
      const existing = await findAgentConversation(project.conversationId, owner, tx)
      if (existing)
        return conversationId && conversationId !== existing.id
          ? { ok: false as const, status: 409 as const, error: 'project_conversation_conflict' }
          : { ok: true as const, conversation: existing }
    }
    const conversation = conversationId
      ? await findAgentConversation(conversationId, owner, tx)
      : await createAgentConversation(owner, '', Date.now(), tx)
    if (!conversation)
      return { ok: false as const, status: 404 as const, error: 'conversation_not_found' }
    const [bound] = await tx
      .select({ id: schema.canvas_projects.id })
      .from(schema.canvas_projects)
      .where(eq(schema.canvas_projects.conversation_id, conversation.id))
    if (bound)
      return { ok: false as const, status: 409 as const, error: 'project_conversation_conflict' }
    await tx
      .update(schema.canvas_projects)
      .set({ conversation_id: conversation.id })
      .where(
        and(eq(schema.canvas_projects.id, projectId), eq(schema.canvas_projects.user_id, userId)),
      )
    return { ok: true as const, conversation }
  })
}

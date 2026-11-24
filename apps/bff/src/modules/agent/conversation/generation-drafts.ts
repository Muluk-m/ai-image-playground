import type { AgentDraftSubmission } from '@image-playground/db'
import type {
  AgentToolName,
  ChannelMedia,
  PersistedSubmitRequest,
  PersistedVideoRequest,
  QueueProvider,
  SubmitRequest,
} from '@image-playground/shared'
import { eq, sql } from 'drizzle-orm'
import { db, schema } from '../../../db/client'
import { archiveInputImages, ObjectStorageError } from '../../../lib/imageArchive'
import { objectStore } from '../../../lib/objectStore'
import type { BffTransaction } from '../../../lib/private-overlay'
import { lockMediaOwner } from '../../../lib/projectMedia'
import { AgentToolError } from '../contracts'

const drafts = schema.agent_generation_drafts

/** 一次工具调用准备好、等用户确认的那份提交材料。 */
export interface GenerationDraftInput {
  readonly conversationId: string
  readonly turnId: string
  readonly toolCallId: string
  readonly toolName: AgentToolName
  readonly media: ChannelMedia
  readonly provider: QueueProvider
  readonly model: string
  /** 拟好的完整提示词：卡上给用户看的、他改的就是这一句。 */
  readonly prompt: string
  /** 送进上游的整份请求，输入图与遮罩此刻还是 data URL。 */
  readonly request: SubmitRequest
  readonly video?: PersistedVideoRequest
  readonly submission: AgentDraftSubmission
}

export async function discardDraftInputs(draftId: string): Promise<void> {
  try {
    await objectStore().deletePrefix(`${draftId}/in/`)
  } catch {
    // Bucket lifecycle cleanup removes any orphan.
  }
}

/**
 * 把这次调用准备好的材料存起来，等用户确认。输入图归档进对象存储，库里只留引用——卡片是下发给
 * 前端的公开内容，字节一律不进那里。存不下就抛：与其留一张点不动的卡，不如当场让这次调用失败。
 */
export async function saveGenerationDraft(
  input: GenerationDraftInput,
  persist?: (draft: typeof drafts.$inferInsert) => Promise<string>,
): Promise<string> {
  const id = crypto.randomUUID()
  let request: PersistedSubmitRequest
  try {
    request = {
      ...(await archiveInputImages(id, input.request)),
      ...(input.video ? { video: input.video } : {}),
    }
  } catch (error) {
    await discardDraftInputs(id)
    if (error instanceof TypeError) throw new AgentToolError('invalid_params', error.message)
    throw new AgentToolError(
      'upstream_error',
      error instanceof ObjectStorageError ? error.message : '保存待确认的生成材料失败',
    )
  }
  try {
    const prepared: typeof drafts.$inferInsert = {
      id,
      conversation_id: input.conversationId,
      turn_id: input.turnId,
      tool_call_id: input.toolCallId,
      tool_name: input.toolName,
      media: input.media,
      provider: input.provider,
      model: input.model,
      prompt: input.prompt,
      drafted_prompt: input.prompt,
      request,
      submission: input.submission,
      created_at: Date.now(),
    }
    if (persist) {
      const savedId = await persist(prepared)
      if (savedId !== id) await discardDraftInputs(id)
      return savedId
    }
    await db.insert(drafts).values(prepared)
    return id
  } catch (error) {
    await discardDraftInputs(id)
    throw error
  }
}

/**
 * 会话删掉之后，它名下那些从没被确认过的草稿就再也点不动了，归档的输入图也就没了读路径。
 * 已确认的草稿输入图在确认那一刻就丢过一次，这里再清一遍是幂等的。
 * 只按会话删，不按时间——待确认卡不因为放久了而过期。
 */
export async function discardConversationDraftInputs(conversationId: string): Promise<void> {
  const rows = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(eq(drafts.conversation_id, conversationId))
  for (const row of rows) await discardDraftInputs(row.id)
}

/**
 * 会话级的咨询锁：确认与删除会话都握它，所以「建任务」与「删会话、取消任务」不会交错。
 * 同一个会话里的两次确认也因此串成一条，双击只会有一条任务。
 */
export async function lockConversation(
  tx: BffTransaction,
  conversationId: string,
  userId: string | null,
): Promise<void> {
  // 项目回收也先锁用户再锁会话；确认、删除与回收必须遵守同一个顺序。
  if (userId) await lockMediaOwner(tx, userId)
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['agent-conversation', conversationId])}, 0))`,
  )
}

import {
  type AgentMessageView,
  type AgentToolErrorCode,
  isShortConfirmation,
} from '@image-playground/shared'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { type ConfirmGenerationOutcome, confirmAgentGeneration } from './confirmations'
import type { AgentOwner } from './conversations'
import { conversationAwaitingClarification } from './inbox'

const PENDING_CONFIRMATION = sql`'[{"type":"toolResult","status":"awaiting_confirmation"}]'::jsonb`

/**
 * 聊天里的短确认语直接提交待确认的生成卡，走与卡片「全部确认 / 确认生成」相同的
 * `confirmAgentGeneration`，计费与建任务和点按钮完全一致。
 *
 * 必须在消息入箱之前做：入箱之后 `userMessageAfterTurn` 会把确认门卡判成不可确认，
 * 而 `prepareAgentTurn` 又会先 `voidPendingToolGates`。两条路都会让「确认」变成作废。
 *
 * 多张待确认生成卡时全部提交，顺序与前端 `confirmAllPrompts` 一致（按卡片落库时间）。
 * 制作模式的稿、节点运行、批次计划不在这里提交。
 */

export function shouldSubmitChatConfirmation(input: {
  readonly text: string
  readonly clarificationAnswer?: boolean
  readonly referenceCount: number
}): boolean {
  if (input.clarificationAnswer) return false
  if (input.referenceCount > 0) return false
  return isShortConfirmation(input.text)
}

export type ChatConfirmSubmitResult =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'submitted'
      readonly messages: readonly AgentMessageView[]
      readonly continued?: true
    }
  | {
      readonly kind: 'refused'
      readonly code: AgentToolErrorCode
      readonly messages: readonly AgentMessageView[]
    }

interface PendingCard {
  readonly messageId: string
  readonly prompt: string
}

export async function listPendingConfirmableDrafts(conversationId: string): Promise<PendingCard[]> {
  const rows = await db
    .select({
      id: schema.agent_messages.id,
      content: schema.agent_messages.content,
    })
    .from(schema.agent_messages)
    .where(
      and(
        eq(schema.agent_messages.conversation_id, conversationId),
        isNull(schema.agent_messages.deleted_at),
        sql`${schema.agent_messages.content} @> ${PENDING_CONFIRMATION}`,
      ),
    )
    .orderBy(asc(schema.agent_messages.created_at), asc(schema.agent_messages.seq))

  const cards: PendingCard[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    for (const block of row.content) {
      if (block.type !== 'toolResult' || block.status !== 'awaiting_confirmation') continue
      if (block.productionDraftRevision !== undefined || block.snapshot?.params?.production)
        continue
      // confirmAgentGeneration 按消息取第一张 toolResult，同一条消息只确认一次。
      if (seen.has(row.id)) continue
      seen.add(row.id)
      cards.push({ messageId: row.id, prompt: block.prompt ?? '' })
    }
  }
  return cards
}

async function ownerOfConversation(conversationId: string, deviceId: string): Promise<AgentOwner> {
  const [row] = await db
    .select({ userId: schema.agent_conversations.user_id })
    .from(schema.agent_conversations)
    .where(eq(schema.agent_conversations.id, conversationId))
    .limit(1)
  return row?.userId ? { kind: 'user', userId: row.userId } : { kind: 'device', deviceId }
}

function acceptedMessage(outcome: ConfirmGenerationOutcome): AgentMessageView | undefined {
  return outcome.kind === 'created' || outcome.kind === 'replayed' ? outcome.message : undefined
}

export async function confirmPendingDraftsFromChat(input: {
  readonly conversationId: string
  readonly deviceId: string
}): Promise<ChatConfirmSubmitResult> {
  const cards = await listPendingConfirmableDrafts(input.conversationId)
  if (!cards.length) return { kind: 'none' }

  const owner = await ownerOfConversation(input.conversationId, input.deviceId)
  const messages: AgentMessageView[] = []
  let continued = false
  const userId = owner.kind === 'user' ? owner.userId : null

  for (const card of cards) {
    const outcome = await confirmAgentGeneration({
      conversationId: input.conversationId,
      owner,
      messageId: card.messageId,
      prompt: card.prompt,
      deviceId: input.deviceId,
      userId,
    })
    if (outcome.kind === 'refused') {
      return { kind: 'refused', code: outcome.code, messages }
    }
    const message = acceptedMessage(outcome)
    if (message) {
      messages.push(message)
      if ('continued' in outcome && outcome.continued) continued = true
    }
  }

  return { kind: 'submitted', messages, ...(continued ? { continued: true as const } : {}) }
}

export async function tryConfirmPendingDraftsFromChat(input: {
  readonly conversationId: string
  readonly text: string
  readonly deviceId: string
  readonly clarificationAnswer?: boolean
  readonly referenceCount: number
}): Promise<ChatConfirmSubmitResult> {
  if (
    !shouldSubmitChatConfirmation({
      text: input.text,
      clarificationAnswer: input.clarificationAnswer,
      referenceCount: input.referenceCount,
    })
  )
    return { kind: 'none' }
  if (await conversationAwaitingClarification(input.conversationId)) return { kind: 'none' }
  return confirmPendingDraftsFromChat({
    conversationId: input.conversationId,
    deviceId: input.deviceId,
  })
}

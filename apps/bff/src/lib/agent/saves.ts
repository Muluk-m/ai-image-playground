import type {
  AgentContentBlock,
  AgentMessageView,
  AgentQueuedMessageView,
  AgentSaveCard,
  AgentSaveCardKind,
  AgentToolResultBlock,
} from '@image-playground/shared'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { isCapabilityEnabled } from '../capabilities'
import { log } from '../logger'
import { enqueueAgentUserMessage } from './inbox'
import type { AgentToolAudience } from './tools/types'

/**
 * 保存卡片这条路的服务端一侧：工具备好卡片，用户在浏览器里把记录写进本机素材库，再回到这里
 * 把卡片改写成「已保存」，并往收件箱里放一条话让智能体接着说下去。
 *
 * 记录本身不经过这里：素材与模板是本机的东西，上云走同步那条路（`/api/sync`）。服务端只动
 * 两样——那张卡的状态，和收件箱里的一条消息。
 */

/**
 * 存素材、存模板这两个工具在不在场。它们要写进**这个人的**素材库：没登录就没有可写的地方；
 * 部署没开同步时素材库只活在这台浏览器里，智能体那边也谈不上「存进库」这件事。
 */
export function agentSaveToolsAvailable(audience: AgentToolAudience | undefined): boolean {
  return Boolean(audience?.userId) && isCapabilityEnabled('accounts:sync')
}

/** 记录的名词。卡片文字、收件箱里那句话与工具说明共用它，三处不会各叫各的。 */
export const AGENT_SAVE_NOUN: Record<AgentSaveCardKind, string> = { asset: '素材', look: '模板' }

export type MarkAgentSaveOutcome =
  | {
      readonly kind: 'saved'
      readonly message: AgentMessageView
      /** 排进收件箱的那条「已保存」；满额没排上时是 null。 */
      readonly queued: AgentQueuedMessageView | null
    }
  /** 这张卡已经保存过（重发的请求、另一台设备抢先）：原样交回，不排第二条消息。 */
  | { readonly kind: 'replayed'; readonly message: AgentMessageView }
  | { readonly kind: 'not_found' }
  /** 认得出这次调用，但它不是保存卡片，或者是另一类记录的卡。 */
  | { readonly kind: 'not_savable' }

export interface MarkAgentSaveInput {
  readonly conversationId: string
  readonly toolCallId: string
  readonly kind: AgentSaveCardKind
  /** 本机记录的 id。服务端只当标识转述给模型，不据它读任何内容。 */
  readonly recordId: string
  /** 用户在卡上最后定下的名字：模型拟的那个可能被他改过。 */
  readonly name: string
  readonly deviceId: string
}

const messages = schema.agent_messages

interface SaveCardRow {
  readonly messageId: string
  readonly turnId: string
  readonly createdAt: number
  readonly content: readonly AgentContentBlock[]
  readonly block: AgentToolResultBlock
  readonly card: AgentSaveCard
}

/** 这个会话里那次调用的结果块。一条消息只装一个结果块，所以 `toolCallId` 就是它的钥匙。 */
async function readSaveCard(
  conversationId: string,
  toolCallId: string,
): Promise<SaveCardRow | 'missing' | 'not_savable'> {
  const [row] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversation_id, conversationId),
        isNull(messages.deleted_at),
        // 参数先定成 text 再转：直接写 `::jsonb`，驱动会把这串 JSON 再编码成一个 jsonb 字符串。
        sql`${messages.content} @> ${JSON.stringify([{ type: 'toolResult', toolCallId }])}::text::jsonb`,
      ),
    )
    .limit(1)
  if (!row) return 'missing'
  const block = row.content.find(
    (one): one is AgentToolResultBlock =>
      one.type === 'toolResult' && one.toolCallId === toolCallId,
  )
  if (!block) return 'missing'
  if (!block.saveCard) return 'not_savable'
  return {
    messageId: row.id,
    turnId: row.turn_id,
    createdAt: row.created_at,
    content: row.content,
    block,
    card: block.saveCard,
  }
}

/**
 * 用户按下了保存。卡片就地改写成已保存（消息 id 不变），并往收件箱里放一条用户消息——
 * 智能体下一轮接着往下说（存完模板通常要请他试一张）。
 *
 * 重复提交是幂等的：卡已经是 `saved` 就原样交回；两台设备同时按下时只有一次改写算数，
 * 收件箱那条话按客户端消息 id 去重，不会排出第二条。
 */
export async function markAgentSaveCardSaved(
  input: MarkAgentSaveInput,
): Promise<MarkAgentSaveOutcome> {
  const row = await readSaveCard(input.conversationId, input.toolCallId)
  if (row === 'missing') return { kind: 'not_found' }
  if (row === 'not_savable' || row.card.kind !== input.kind) return { kind: 'not_savable' }
  const message = (content: readonly AgentContentBlock[]): AgentMessageView => ({
    id: row.messageId,
    turnId: row.turnId,
    role: 'assistant',
    content: [...content],
    createdAt: row.createdAt,
  })
  if (row.card.status === 'saved') return { kind: 'replayed', message: message(row.content) }
  const card: AgentSaveCard = {
    ...row.card,
    status: 'saved',
    recordId: input.recordId,
    name: input.name.trim() || row.card.name,
  }
  const content = row.content.map((one) =>
    one === row.block ? { ...row.block, saveCard: card } : one,
  )
  // 只在这条消息还是读到时的样子才写：另一台设备抢先存下时，这一次让位给它，不覆盖它的记录 id。
  const written = await db
    .update(messages)
    .set({ content })
    .where(
      and(
        eq(messages.conversation_id, input.conversationId),
        eq(messages.id, row.messageId),
        sql`${messages.content} = ${JSON.stringify(row.content)}::text::jsonb`,
      ),
    )
    .returning({ id: messages.id })
  if (written.length === 0) {
    const fresh = await readSaveCard(input.conversationId, input.toolCallId)
    if (typeof fresh === 'string') return { kind: 'not_found' }
    return { kind: 'replayed', message: message(fresh.content) }
  }
  const enqueued = await enqueueAgentUserMessage(input.conversationId, {
    // 同一张卡只排一条：重发的请求撞上同一个客户端消息 id，收件箱认得出来。
    clientMessageId: `save:${input.toolCallId}`,
    text: `用户已保存${AGENT_SAVE_NOUN[card.kind]}「${card.name}」（id: ${input.recordId}）`,
    references: [],
    deviceId: input.deviceId,
  })
  if (enqueued.kind === 'full') {
    log.warn(
      { event: 'agent.save_notice_dropped', conversationId: input.conversationId },
      'inbox full, agent was not told about the save',
    )
    return { kind: 'saved', message: message(content), queued: null }
  }
  return { kind: 'saved', message: message(content), queued: enqueued.entry.view }
}

import type { AgentConversationView } from '@image-playground/shared'
import { agentConversationTitle } from '@image-playground/shared'
import { config } from '../../config'
import { db } from '../../db/client'
import { isCapabilityEnabled } from '../capabilities'
import { loadPrivateBffOverlay } from '../private-overlay'
import { actualChatUsage, reservedChatUsage } from './billing'
import {
  type AgentOwner,
  appendAgentMessage,
  listAgentMessages,
  setAgentConversationTitle,
} from './conversations'
import type { RunningTurn } from './runningTurns'
import type { AgentTurnSettlement } from './turn'

export interface StartConversationTurnInput {
  readonly conversation: AgentConversationView
  readonly owner: AgentOwner
  readonly userId: string | null
  readonly text: string
}

export type StartConversationTurnResult =
  | { readonly kind: 'started'; readonly turn: RunningTurn }
  | { readonly kind: 'authentication_required' }
  | {
      readonly kind: 'insufficient_credits'
      readonly required: number
      readonly available: number
    }
  | { readonly kind: 'price_unavailable'; readonly model: string }

/**
 * 起一轮的用例：改标题、落用户消息、预扣积分在同一个事务里，任一步失败整笔不落地。
 * 结算等轮跑完才有用量，走轮自己的收尾钩子。
 */
export async function startConversationTurn(
  input: StartConversationTurnInput,
): Promise<StartConversationTurnResult> {
  const { conversation, owner, userId, text } = input
  const billed = isCapabilityEnabled('billing:credits')
  if (billed && !userId) return { kind: 'authentication_required' }

  // 动态引入：pi 的模块图有 60-90ms，`agent:chat` 关着的部署不该在启动时付。
  const { estimateTurnInputTokens, startAgentTurn } = await import('./turn')
  const taskHooks = (await loadPrivateBffOverlay()).taskHooks
  const history = await listAgentMessages(conversation.id, owner)
  const turnId = crypto.randomUUID()

  const reserved = await db.transaction(async (tx) => {
    if (billed) {
      const reservation = await taskHooks.reserveTask({
        tx,
        taskId: turnId,
        userId: userId!,
        model: config.agent.model,
        ...reservedChatUsage(estimateTurnInputTokens(history, text)),
      })
      if (reservation.kind !== 'reserved') return reservation
    }
    if (history.length === 0) {
      await setAgentConversationTitle(tx, conversation.id, owner, agentConversationTitle(text))
    }
    const userMessage = await appendAgentMessage(tx, {
      conversationId: conversation.id,
      turnId,
      role: 'user',
      content: [{ type: 'text', text }],
    })
    return { kind: 'reserved' as const, userMessageId: userMessage.id }
  })
  if (reserved.kind !== 'reserved') return reserved

  const settle = billed
    ? async (settlement: AgentTurnSettlement) => {
        await db.transaction(async (tx) => {
          await taskHooks.finalizeTask({
            tx,
            taskId: turnId,
            outcome: settlement.outcome,
            upstreamInvocationCount: settlement.upstreamInvocationCount,
            // usage 为 null 是上游没报，缺席即按预留全额结算——退错方向就是凭空造积分。
            ...(settlement.usage ? { actualUsage: actualChatUsage(settlement.usage) } : {}),
          })
        })
      }
    : undefined

  return {
    kind: 'started',
    turn: await startAgentTurn({
      conversationId: conversation.id,
      turnId,
      userMessageId: reserved.userMessageId,
      history,
      text,
      settle,
    }),
  }
}

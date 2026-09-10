import type { AgentTurnReference } from '@image-playground/shared'
import { agentConversationTitle } from '@image-playground/shared'
import { config } from '../../config'
import { db } from '../../db/client'
import { isCapabilityEnabled } from '../capabilities'
import {
  loadPrivateBffOverlay,
  type PrivateTaskHooks,
  type TaskReservationFailure,
} from '../private-overlay'
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
  readonly conversationId: string
  readonly owner: AgentOwner
  readonly text: string
  /** 输入框里附上的参考图，序号就是提示词里的 `[image N]`。 */
  readonly references: readonly AgentTurnReference[]
  /** 归属是用户时 owner 里没有设备，但工具提交的任务仍要按设备计日配额。 */
  readonly deviceId: string
}

export type StartConversationTurnResult =
  | { readonly kind: 'started'; readonly turn: RunningTurn }
  | { readonly kind: 'authentication_required' }
  | TaskReservationFailure

/** 结算是模块级工厂而不是用例里的闭包：闭包会把整段历史钉到轮结束。 */
function chatSettlement(taskHooks: PrivateTaskHooks, turnId: string) {
  return async (settlement: AgentTurnSettlement) => {
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
}

/** 改标题、落用户消息、预扣积分在同一个事务里，任一步失败整笔不落地。 */
export async function startConversationTurn(
  input: StartConversationTurnInput,
): Promise<StartConversationTurnResult> {
  const { conversationId, owner, text, references, deviceId } = input
  const userId = owner.kind === 'user' ? owner.userId : null
  const billed = isCapabilityEnabled('billing:credits')
  if (billed && owner.kind !== 'user') return { kind: 'authentication_required' }

  // 动态引入：pi 的模块图有 60-90ms，`agent:chat` 关着的部署不该在启动时付。
  const [{ estimateTurnInputTokens, startAgentTurn }, overlay, history] = await Promise.all([
    import('./turn'),
    loadPrivateBffOverlay(),
    listAgentMessages(conversationId, owner),
  ])
  const turnId = crypto.randomUUID()
  const reservation =
    billed && userId
      ? {
          taskId: turnId,
          userId,
          model: config.agent.model,
          ...reservedChatUsage(estimateTurnInputTokens(history, text)),
        }
      : null

  const written = await db.transaction(async (tx) => {
    if (reservation) {
      const reserved = await overlay.taskHooks.reserveTask({ tx, ...reservation })
      if (reserved.kind !== 'reserved') return reserved
    }
    if (history.length === 0) {
      await setAgentConversationTitle(tx, conversationId, owner, agentConversationTitle(text))
    }
    const userMessage = await appendAgentMessage(tx, {
      conversationId,
      turnId,
      role: 'user',
      content: [{ type: 'text', text }],
    })
    return { kind: 'reserved' as const, userMessageId: userMessage.id }
  })
  if (written.kind !== 'reserved') return written

  return {
    kind: 'started',
    turn: await startAgentTurn({
      conversationId,
      turnId,
      userMessageId: written.userMessageId,
      history,
      text,
      references,
      userId,
      deviceId,
      settle: reservation ? chatSettlement(overlay.taskHooks, turnId) : undefined,
    }),
  }
}

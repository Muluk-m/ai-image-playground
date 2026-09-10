import type { AgentTurnCost, AgentTurnReference } from '@image-playground/shared'
import { agentConversationTitle } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { config } from '../../config'
import { db, schema } from '../../db/client'
import { finishTask } from '../../db/task-transitions'
import { isCapabilityEnabled } from '../capabilities'
import type { BffTransaction, ChatPricing, TaskReservationFailure } from '../private-overlay'
import { loadPrivateBffOverlay } from '../private-overlay'
import { actualChatUsage, FALLBACK_CHAT_PRICING, reservedChatUsage } from './billing'
import {
  type AgentOwner,
  appendAgentMessage,
  listAgentMessages,
  setAgentConversationTitle,
} from './conversations'
import type { RunningTurn } from './runningTurns'
import type { AgentTurnSettlement } from './turn'
import { collectTurnCost } from './turn-cost'

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

/**
 * 积分占用挂在 task_id 上，而私有账本对 tasks 有外键，所以对话轮必须先有一条自己的任务行。
 * 状态直接进 in_progress：worker 只 claim `queued`，这一行它永远捞不走。
 */
async function insertChatTask(
  tx: BffTransaction,
  input: { taskId: string; conversationId: string; userId: string; deviceId: string },
): Promise<void> {
  const now = Date.now()
  await tx.insert(schema.tasks).values({
    id: input.taskId,
    kind: 'chat',
    provider: 'openai-compat',
    model: config.agent.model,
    status: 'in_progress',
    // 会话内容不进后台，占位里只留设备号——它喂的是 device_id 那个生成列。
    request_payload: { prompt: '', device_id: input.deviceId },
    submitted_at: now,
    started_at: now,
    user_id: input.userId,
    agent_conversation_id: input.conversationId,
    agent_turn_id: input.taskId,
  })
}

/** 结算是模块级工厂而不是用例里的闭包：闭包会把整段历史钉到轮结束。 */
function chatSettlement(conversationId: string, turnId: string, pricing: ChatPricing) {
  return async (settlement: AgentTurnSettlement): Promise<AgentTurnCost> => {
    await finishTask(turnId, {
      status: settlement.outcome,
      completedAt: Date.now(),
      upstreamInvocationCount: settlement.upstreamInvocationCount,
      // usage 为 null 是上游没报，缺席即按预留全额结算——退错方向就是凭空造积分。
      ...(settlement.usage ? { actualUsage: actualChatUsage(settlement.usage, pricing) } : {}),
    })
    return collectTurnCost(conversationId, turnId)
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
  const overlayPromise = loadPrivateBffOverlay()
  const [{ estimateTurnInputTokens, startAgentTurn }, overlay, history, configured] =
    await Promise.all([
      import('./turn'),
      overlayPromise,
      listAgentMessages(conversationId, owner),
      billed ? overlayPromise.then((it) => it.taskHooks.chatPricing(config.agent.model)) : null,
    ])
  const turnId = crypto.randomUUID()
  // 预扣与结算共用这一份快照：运营中途改价不该改写在途那一轮的账。
  const pricing = configured ?? FALLBACK_CHAT_PRICING
  const reservation =
    billed && userId
      ? {
          taskId: turnId,
          userId,
          model: config.agent.model,
          ...reservedChatUsage(estimateTurnInputTokens(history, text), pricing),
        }
      : null

  const written = await db.transaction(async (tx) => {
    let reservedCredits: number | undefined
    if (reservation) {
      await insertChatTask(tx, {
        taskId: turnId,
        conversationId,
        userId: reservation.userId,
        deviceId,
      })
      const reserved = await overlay.taskHooks.reserveTask({ tx, ...reservation })
      if (reserved.kind !== 'reserved') {
        // 余额不足的轮压根没发生过，别把这条任务行留给恢复扫描去收尸。
        await tx.delete(schema.tasks).where(eq(schema.tasks.id, turnId))
        return reserved
      }
      reservedCredits = reserved.credits
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
    return { kind: 'reserved' as const, userMessageId: userMessage.id, reservedCredits }
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
      reservedCredits: written.reservedCredits,
      settle: reservation ? chatSettlement(conversationId, turnId, pricing) : undefined,
    }),
  }
}

import type { AgentMode, AgentTurnParams, AgentTurnReference } from '@image-playground/shared'
import { agentConversationTitle } from '@image-playground/shared'
import { db } from '../../db/client'
import { isCapabilityEnabled } from '../capabilities'
import type { TaskReservationFailure } from '../private-overlay'
import { loadPrivateBffOverlay } from '../private-overlay'
import { type ChatTaskReserved, chatTaskPricing, reserveChatTask } from './chat-task'
import {
  type AgentOwner,
  appendAgentMessage,
  listAgentMessages,
  setAgentConversationTitle,
} from './conversations'
import { archiveAgentReferences, removeAgentTurnReferences } from './images'
import type { RunningTurn } from './runningTurns'
import { ensureAgentSkills } from './skills'
import { agentThinking } from './thinking'

export interface StartConversationTurnInput {
  readonly conversationId: string
  readonly owner: AgentOwner
  readonly text: string
  /** 输入框里附上的参考图，序号就是提示词里的 `[image N]`。 */
  readonly references: readonly AgentTurnReference[]
  /** 归属是用户时 owner 里没有设备，但工具提交的任务仍要按设备计日配额。 */
  readonly deviceId: string
  /** 这一轮要创作什么；缺席即图片，老客户端不知道有这回事。 */
  readonly mode?: AgentMode
  /** 用户在输入框的参数浮层里选的生成参数；缺席即全部按部署默认。 */
  readonly params?: AgentTurnParams
}

export type StartConversationTurnResult =
  | { readonly kind: 'started'; readonly turn: RunningTurn }
  | { readonly kind: 'authentication_required' }
  | TaskReservationFailure

/** 改标题、落用户消息、预扣积分在同一个事务里，任一步失败整笔不落地。 */
export async function startConversationTurn(
  input: StartConversationTurnInput,
): Promise<StartConversationTurnResult> {
  const { conversationId, owner, text, references, deviceId, params } = input
  const mode: AgentMode = input.mode ?? 'image'
  const selectedModel = agentThinking(params?.thinkingDepth).model
  const userId = owner.kind === 'user' ? owner.userId : null
  const billed = isCapabilityEnabled('billing:credits')
  if (billed && owner.kind !== 'user') return { kind: 'authentication_required' }

  // 动态引入：pi 的模块图有 60-90ms，`agent:chat` 关着的部署不该在启动时付。
  // `turn-input` 也静态依赖 pi，所以它同样只能晚到这里，且与 `turn` 并排等在同一组里。
  const overlayPromise = loadPrivateBffOverlay()
  // 技能清单进系统提示词，所以预扣估算之前就得读完盘；加载只发生一次，之后都是缓存。
  const [{ estimateTurnInputTokens }, { startAgentTurn }, overlay, history, pricing] =
    await Promise.all([
      import('./turn-input'),
      import('./turn'),
      overlayPromise,
      listAgentMessages(conversationId, owner),
      billed ? overlayPromise.then((it) => chatTaskPricing(it.taskHooks, selectedModel)) : null,
      ensureAgentSkills(),
    ])
  const turnId = crypto.randomUUID()
  const chatTask =
    pricing && userId
      ? {
          taskHooks: overlay.taskHooks,
          conversationId,
          turnId,
          userId,
          deviceId,
          model: selectedModel,
          estimatedInputTokens: estimateTurnInputTokens(history, text, references, mode),
          pricing,
        }
      : null
  const storedReferences = await archiveAgentReferences(conversationId, turnId, references)

  const written = await db
    .transaction(async (tx) => {
      let reserved: ChatTaskReserved | undefined
      if (chatTask) {
        const reservation = await reserveChatTask({ tx, ...chatTask })
        if (reservation.kind !== 'reserved') return reservation
        reserved = reservation
      }
      if (history.length === 0) {
        await setAgentConversationTitle(tx, conversationId, owner, agentConversationTitle(text))
      }
      const userMessage = await appendAgentMessage(tx, {
        conversationId,
        turnId,
        role: 'user',
        content: [
          {
            type: 'text',
            text,
            ...(storedReferences.length ? { references: storedReferences } : {}),
          },
        ],
      })
      return { kind: 'reserved' as const, userMessageId: userMessage.id, reserved }
    })
    .catch(async (error) => {
      if (storedReferences.length) await removeAgentTurnReferences(conversationId, turnId)
      throw error
    })
  if (written.kind !== 'reserved') {
    if (storedReferences.length) await removeAgentTurnReferences(conversationId, turnId)
    return written
  }

  return {
    kind: 'started',
    turn: await startAgentTurn({
      conversationId,
      turnId,
      userMessageId: written.userMessageId,
      history,
      text,
      references,
      mode,
      userId,
      deviceId,
      ...(params ? { params } : {}),
      reservedCredits: written.reserved?.reservedCredits,
      settle: written.reserved?.settle,
    }),
  }
}

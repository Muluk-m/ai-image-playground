import type { AgentMode, AgentTurnParams, AgentTurnReference } from '@image-playground/shared'
import { agentConversationTitle } from '@image-playground/shared'
import { isCapabilityEnabled } from '../capabilities'
import { bffDrain } from '../drain'
import type { TaskReservationFailure } from '../private-overlay'
import { loadPrivateBffOverlay } from '../private-overlay'
import { type ChatTaskReserved, chatTaskPricing, reserveChatTask } from './chat-task'
import {
  type AgentOwner,
  appendAgentMessage,
  listAgentMessages,
  setAgentConversationTitle,
} from './conversations'
import { isSealLease, sealAbandonedTurns } from './events'
import {
  assertConversationExecution,
  ConversationExecutionLost,
  claimConversation,
  conversationExecution,
  maintainConversation,
  releaseConversation,
  withConversationExecution,
} from './execution'
import { archiveAgentReferences, removeAgentTurnReferences } from './images'
import type { RunningTurn } from './runningTurns'
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
  | { readonly kind: 'draining' }
  | { readonly kind: 'already_running'; readonly turnId: string }
  | TaskReservationFailure

/** 改标题、落用户消息、预扣积分在同一个事务里，任一步失败整笔不落地。 */
export async function startConversationTurn(
  input: StartConversationTurnInput,
): Promise<StartConversationTurnResult> {
  const release = bffDrain.enter()
  if (!release) return { kind: 'draining' }
  const turnId = crypto.randomUUID()
  let claimed = false
  let stopHeartbeat = () => {}
  let turn: RunningTurn | undefined
  let ownershipLost = false
  try {
    claimed = await claimWaitingOutSeal(input.conversationId, turnId)
    if (!claimed) {
      const active = await conversationExecution(input.conversationId)
      release()
      return { kind: 'already_running', turnId: active?.turn_id ?? turnId }
    }
    // 上一轮若被打断没有终帧，先在租约下补上，再给这一轮发序号：终帧排在新一轮之前。
    await sealAbandonedTurns(input.conversationId, true)
    stopHeartbeat = maintainConversation(input.conversationId, turnId, () => {
      ownershipLost = true
      turn?.abort()
    })
    const result = await executeConversationTurn(input, turnId, async () => {
      if (ownershipLost) throw new ConversationExecutionLost()
      await assertConversationExecution(input.conversationId, turnId)
    })
    if (result.kind === 'started') {
      turn = result.turn
      if (ownershipLost) turn.abort()
    }
    const finish = async () => {
      stopHeartbeat()
      await releaseConversation(input.conversationId, turnId)
      release()
    }
    if (result.kind === 'started' && result.turn.completed) {
      void result.turn.completed.then(finish).catch(() => bffDrain.failed())
    } else {
      await finish()
    }
    return result
  } catch (error) {
    stopHeartbeat()
    if (claimed) await releaseConversation(input.conversationId, turnId)
    release()
    throw error
  }
}

/** 补写终帧只占几次数据库往返；撞上它就等它放手，最多等这么久。 */
const SEAL_WAIT_MS = 2_000
const SEAL_POLL_MS = 50

/**
 * 领会话租约；占着租约的若是补写终帧而不是一轮，等它写完再领。
 * 补写不是用户能看到的轮，撞上它回 409 会让客户端去续播一个不存在的轮。
 */
async function claimWaitingOutSeal(conversationId: string, turnId: string): Promise<boolean> {
  const deadline = Date.now() + SEAL_WAIT_MS
  while (true) {
    if (await claimConversation(conversationId, turnId)) return true
    const holder = await conversationExecution(conversationId)
    if (holder && !isSealLease(holder.turn_id)) return false
    if (Date.now() >= deadline) return false
    if (holder) await new Promise((resolve) => setTimeout(resolve, SEAL_POLL_MS))
  }
}

async function executeConversationTurn(
  input: StartConversationTurnInput,
  turnId: string,
  assertOwnership: () => Promise<void>,
): Promise<StartConversationTurnResult> {
  const { conversationId, owner, text, references, deviceId, params } = input
  const selectedModel = agentThinking(params?.thinkingDepth).model
  const userId = owner.kind === 'user' ? owner.userId : null
  const billed = isCapabilityEnabled('billing:credits')
  if (billed && owner.kind !== 'user') return { kind: 'authentication_required' }

  // 动态引入：pi 的模块图有 60-90ms，`agent:chat` 关着的部署不该在启动时付。
  // `turn-input` 也静态依赖 pi，所以它同样只能晚到这里，且与 `turn` 并排等在同一组里。
  const overlayPromise = loadPrivateBffOverlay()
  // `skills` 与 `tools` 也静态依赖 pi，所以同样只能晚到这里。技能清单进系统提示词，
  // 预扣估算之前就得读完盘；加载只发生一次，之后都是缓存。
  const [
    { estimateTurnInputTokens },
    { startAgentTurn },
    { resolveAgentMode },
    overlay,
    history,
    pricing,
  ] = await Promise.all([
    import('./turn-input'),
    import('./turn'),
    import('./tools'),
    overlayPromise,
    listAgentMessages(conversationId, owner),
    billed ? overlayPromise.then((it) => chatTaskPricing(it.taskHooks, selectedModel)) : null,
    import('./skills').then((it) => it.ensureAgentSkills()),
  ])
  const mode: AgentMode = resolveAgentMode(input.mode ?? 'image')
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

  const written = await withConversationExecution(conversationId, turnId, async (tx) => {
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
  }).catch(async (error) => {
    if (storedReferences.length) await removeAgentTurnReferences(conversationId, turnId)
    throw error
  })
  if (written.kind !== 'reserved') {
    if (storedReferences.length) await removeAgentTurnReferences(conversationId, turnId)
    return written
  }

  await assertOwnership()
  return {
    kind: 'started',
    turn: await startAgentTurn({
      assertExecution: assertOwnership,
      withExecution: (callback) => withConversationExecution(conversationId, turnId, callback),
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

import type {
  AgentMode,
  AgentQueuedMessageFailure,
  AgentTurnParams,
  AgentTurnReference,
} from '@image-playground/shared'
import { AGENT_QUEUE_MAX_PENDING, agentConversationTitle } from '@image-playground/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { isCapabilityEnabled } from '../capabilities'
import { bffDrain } from '../drain'
import { log } from '../logger'
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
  agentInstance,
  assertConversationExecution,
  ConversationExecutionLost,
  claimConversation,
  conversationExecution,
  maintainConversation,
  releaseConversation,
  withConversationExecution,
} from './execution'
import { archiveAgentReferences, removeAgentTurnReferences } from './images'
import {
  consumeAgentMessage,
  failAgentMessage,
  nextAgentInboxEntry,
  type QueuedWake,
} from './inbox'
import { type RunningTurn, runningTurn } from './runningTurns'
import { agentThinking } from './thinking'
import { deliverDueAgentWakes, wakePlan } from './wake'
import {
  wakeAuthorizationPrompt,
  wakeJobs,
  wakeReviewImageIds,
  wakeTurnPrompt,
  wakeTurnSetup,
} from './wake-prompt'

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

/**
 * 没能开轮的原因。调用方刚收进来的那一条（`quietFor`）原样留着待处理，由调用方决定去留；
 * 排着的别的那一条则记成没能开轮，见 {@link drainConversationInbox}。
 */
export type TurnNotStarted =
  | { readonly kind: 'authentication_required' }
  | { readonly kind: 'draining' }
  | TaskReservationFailure

type StartConversationTurnResult =
  | { readonly kind: 'started'; readonly turn: RunningTurn }
  /** 起轮半路那一条被撤回了：什么都没落，换下一条。 */
  | { readonly kind: 'withdrawn' }
  | TurnNotStarted

export type DrainConversationResult =
  /** 取走 `queueId` 那一条开了一轮。 */
  | { readonly kind: 'started'; readonly turn: RunningTurn; readonly queueId: string }
  /** 收件箱里没有待处理的用户消息。 */
  | { readonly kind: 'idle' }
  /** 会话正被一轮占着；它收尾时会自己接着取。 */
  | { readonly kind: 'already_running'; readonly turnId: string }
  | {
      readonly kind: 'not_started'
      readonly queueId: string
      readonly failure: TurnNotStarted
    }

export interface DrainConversationOptions {
  /**
   * 调用方刚收进来的那一条。它若当场开了轮，就是一次普通的发送，不必在事件流里宣布「排队已消费」：
   * 它从没在谁的排队列表里出现过。
   */
  readonly quietFor?: string
}

/**
 * 处理会话收件箱里的下一条用户消息：领会话租约、取走一条、开一轮，每轮只取一条。
 * 那一轮收尾放手之后再接着取下一条，直到收件箱空了。会话正被别的轮占着就什么都不做——
 * 占着的那一轮收尾时会来取。
 *
 * 排着的一条轮到时开不了轮（余额不足、需要登录……）就记成没能开轮、带上错误码，接着取
 * 下一条：它不能一直挡在队首，用户也得知道它为什么没被处理。本实例正在下线时则什么都不动，
 * 留给新版本接手（见 `inbox-pickup`）。
 */
export async function drainConversationInbox(
  conversationId: string,
  options: DrainConversationOptions = {},
): Promise<DrainConversationResult> {
  // 撤回与起轮抢同一条、放手后又来了新的、排着的开不了轮：都换下一条重来。
  // 次数有上限（满队每条各一次再留些余量），不会空转。
  for (let attempt = 0; attempt < AGENT_QUEUE_MAX_PENDING + 4; attempt += 1) {
    const result = await drainOnce(conversationId, options)
    if (result !== 'again') return result
  }
  return { kind: 'idle' }
}

async function drainOnce(
  conversationId: string,
  options: DrainConversationOptions,
): Promise<DrainConversationResult | 'again'> {
  const release = bffDrain.enter()
  if (!release) {
    const next = await nextAgentInboxEntry(conversationId)
    return next
      ? { kind: 'not_started', queueId: next.id, failure: { kind: 'draining' } }
      : { kind: 'idle' }
  }
  // 没有该取的就不领租约：空领一次也会让会话在那一瞬间显得还忙。在等澄清答复、只剩问之前
  // 排着的那几条时，巡查与快照读取都会来问，不能每次都占一下。
  if (!(await nextAgentInboxEntry(conversationId))) {
    release()
    return { kind: 'idle' }
  }
  const turnId = crypto.randomUUID()
  let claimed = false
  let stopHeartbeat = () => {}
  let turn: RunningTurn | undefined
  let ownershipLost = false
  try {
    claimed = await claimWaitingOutSeal(conversationId, turnId)
    if (!claimed) {
      const active = await conversationExecution(conversationId)
      release()
      return { kind: 'already_running', turnId: active?.turn_id ?? turnId }
    }
    // 上一轮若被打断没有终帧，先在租约下补上，再给这一轮发序号：终帧排在新一轮之前。
    await sealAbandonedTurns(conversationId, true)
    const next = await nextAgentInboxEntry(conversationId)
    const owner = next ? await conversationOwner(conversationId) : null
    if (!next || !owner) {
      await releaseConversation(conversationId, turnId)
      release()
      // 放手之前入队、又因为租约在这里而没能自己开轮的那一条，只能由这里接着取。
      return next === null && (await nextAgentInboxEntry(conversationId))
        ? 'again'
        : { kind: 'idle' }
    }
    stopHeartbeat = maintainConversation(conversationId, turnId, () => {
      ownershipLost = true
      turn?.abort()
    })
    const assertOwnership = async () => {
      if (ownershipLost) throw new ConversationExecutionLost()
      await assertConversationExecution(conversationId, turnId)
    }
    const result =
      next.kind === 'task_result'
        ? await executeWakeTurn(conversationId, owner, next, turnId, assertOwnership)
        : await executeConversationTurn(
            {
              conversationId,
              owner,
              text: next.text,
              references: next.references,
              deviceId: next.deviceId,
              ...(next.mode ? { mode: next.mode } : {}),
              ...(next.params ? { params: next.params } : {}),
            },
            turnId,
            assertOwnership,
            { id: next.id, announce: next.id !== options.quietFor },
          )
    if (result.kind === 'started') {
      turn = result.turn
      if (ownershipLost) turn.abort()
    }
    const finish = async () => {
      stopHeartbeat()
      await releaseConversation(conversationId, turnId)
      release()
    }
    if (result.kind === 'started' && result.turn.completed) {
      void result.turn.completed.then(finish).then(
        // 这一轮放手了：它提交的后台任务若已全部结束，此刻才凑齐一批，先投递唤醒；然后排着的
        // 下一条接着开轮。队里没有待处理的就不再领租约——空领一次也会让刚收尾的会话在那一瞬间
        // 显得还忙，删会话之类的操作会撞上 409。放手之后才进来的那条由它自己的请求开轮。
        () =>
          void deliverDueAgentWakes([conversationId])
            .then(() => nextAgentInboxEntry(conversationId))
            .then((waiting) => (waiting ? drainConversationInbox(conversationId) : undefined))
            .catch((err) =>
              log.error(
                { event: 'agent.inbox_drain_failed', conversationId, err },
                'queued agent message could not start a turn',
              ),
            ),
        () => bffDrain.failed(),
      )
    } else {
      await finish()
    }
    if (result.kind === 'started') return { kind: 'started', turn: result.turn, queueId: next.id }
    if (result.kind === 'withdrawn') return 'again'
    if (next.id !== options.quietFor) {
      // 排着的这一条开不了轮：记下原因，换下一条。
      await failAgentMessage(conversationId, next.id, queuedFailureOf(result))
      return 'again'
    }
    return { kind: 'not_started', queueId: next.id, failure: result }
  } catch (error) {
    stopHeartbeat()
    if (claimed) await releaseConversation(conversationId, turnId)
    release()
    throw error
  }
}

/**
 * 唤醒轮：后台任务结束，智能体回来看结果。没有用户消息可落，模型收到的是一段系统说明，
 * 点名这一批里的结果；计费、租约与普通的轮一样。
 */
async function executeWakeTurn(
  conversationId: string,
  owner: AgentOwner,
  wake: QueuedWake,
  turnId: string,
  assertOwnership: () => Promise<void>,
): Promise<StartConversationTurnResult> {
  const userId = owner.kind === 'user' ? owner.userId : null
  const billed = isCapabilityEnabled('billing:credits')
  if (billed && owner.kind !== 'user') return { kind: 'authentication_required' }
  const overlayPromise = loadPrivateBffOverlay()
  const [
    { estimateTurnInputTokens },
    { startAgentTurn },
    { resolveAgentMode },
    overlay,
    history,
    plan,
  ] = await Promise.all([
    import('./turn-input'),
    import('./turn'),
    import('./tools'),
    overlayPromise,
    // 读历史会把结束了的后台任务结算成终局：唤醒轮看到的就是它们的结果。
    listAgentMessages(conversationId, owner),
    // 提交这一批时的改图计划：唤醒轮接着它走，不另起一份。
    wakePlan(wake.taskIds),
    import('./skills').then((it) => it.ensureAgentSkills()),
  ])
  const jobs = wakeJobs(history, wake.taskIds)
  if (jobs.length === 0) {
    // 点名的结果卡一张都不在（那一轮没能落下结果卡就没了）：没有可看的，取走它不起轮。
    await withConversationExecution(conversationId, turnId, (tx) =>
      consumeAgentMessage(tx, conversationId, wake.id, turnId),
    )
    return { kind: 'withdrawn' }
  }
  const setup = wakeTurnSetup(jobs)
  const mode = resolveAgentMode(setup.mode)
  const { params } = setup
  const selectedModel = agentThinking(params?.thinkingDepth).model
  const text = wakeTurnPrompt(jobs)
  const reviewImageIds = wakeReviewImageIds(jobs)
  const deviceId = wake.deviceId || (owner.kind === 'device' ? owner.deviceId : '')
  const pricing = billed && userId ? await chatTaskPricing(overlay.taskHooks, selectedModel) : null
  const chatTask =
    pricing && userId
      ? {
          taskHooks: overlay.taskHooks,
          conversationId,
          turnId,
          userId,
          deviceId,
          model: selectedModel,
          // 要复核的产物作为视觉证据随这一轮发出去，预扣时一并算上。
          estimatedInputTokens: estimateTurnInputTokens(history, text, [], mode, reviewImageIds),
          pricing,
        }
      : null
  const written = await withConversationExecution(conversationId, turnId, async (tx) => {
    if (!(await consumeAgentMessage(tx, conversationId, wake.id, turnId)))
      throw new TurnStartRollback({ kind: 'withdrawn' })
    let reserved: ChatTaskReserved | undefined
    if (chatTask) {
      const reservation = await reserveChatTask({ tx, ...chatTask })
      if (reservation.kind !== 'reserved') throw new TurnStartRollback(reservation)
      reserved = reservation
    }
    return { kind: 'reserved' as const, reserved }
  }).catch((error) => {
    if (error instanceof TurnStartRollback) return error.result
    throw error
  })
  if (written.kind !== 'reserved') return written

  await assertOwnership()
  return {
    kind: 'started',
    turn: await startAgentTurn({
      assertExecution: assertOwnership,
      withExecution: (callback) => withConversationExecution(conversationId, turnId, callback),
      conversationId,
      turnId,
      // 唤醒没有用户消息；这个 id 不指向任何一条，只让轮头的形状与普通的轮一致。
      userMessageId: `${turnId}:wake`,
      history,
      text,
      references: [],
      mode,
      userId,
      deviceId,
      ...(params ? { params } : {}),
      wake: {
        authorizationPrompt: wakeAuthorizationPrompt(history, wake.turnId),
        ...(plan ? { plan } : {}),
        reviewImageIds,
      },
      reservedCredits: written.reserved?.reservedCredits,
      settle: written.reserved?.settle,
    }),
  }
}

/** 开不了轮的原因换成界面认得的错误码，与发送时同一情形的 HTTP 错误码一致。 */
function queuedFailureOf(failure: TurnNotStarted): AgentQueuedMessageFailure {
  switch (failure.kind) {
    case 'insufficient_credits':
      return 'insufficient_credits'
    case 'price_unavailable':
      return 'model_price_unavailable'
    default:
      // 需要登录。下线中（`draining`）不会走到这里：那时什么都不动。
      return 'unauthorized'
  }
}

/** 会话此刻的归属；删了的会话不再开轮。 */
async function conversationOwner(conversationId: string): Promise<AgentOwner | null> {
  const [row] = await db
    .select({
      userId: schema.agent_conversations.user_id,
      deviceId: schema.agent_conversations.device_id,
    })
    .from(schema.agent_conversations)
    .where(
      and(
        eq(schema.agent_conversations.id, conversationId),
        isNull(schema.agent_conversations.deleted_at),
      ),
    )
  if (!row) return null
  if (row.userId) return { kind: 'user', userId: row.userId }
  return row.deviceId ? { kind: 'device', deviceId: row.deviceId } : null
}

/** 事务里的提前收场：取走或预扣有一步不成立，整笔回滚，收件箱里那一条原样待处理。 */
class TurnStartRollback extends Error {
  constructor(readonly result: StartConversationTurnResult) {
    super('turn start rolled back')
  }
}

/** 补写终帧、上一轮放手都只占几次数据库往返；撞上它们就等一等，最多等这么久。 */
const SEAL_WAIT_MS = 2_000
const SEAL_POLL_MS = 50

/**
 * 领会话租约；占着租约的若是补写终帧、或者本进程里已经收了尾正在放手的上一轮，等它放手再领。
 * 两者都不是用户还能接着看的轮：撞上补写回 409 会让客户端去续播一个不存在的轮，撞上正在
 * 放手的上一轮则会把一句当场就能开轮的话平白排进队里。
 */
async function claimWaitingOutSeal(conversationId: string, turnId: string): Promise<boolean> {
  const deadline = Date.now() + SEAL_WAIT_MS
  while (true) {
    if (await claimConversation(conversationId, turnId)) return true
    const holder = await conversationExecution(conversationId)
    const finishing =
      holder?.instance === agentInstance && runningTurn(conversationId) === undefined
    if (holder && !isSealLease(holder.turn_id) && !finishing) return false
    if (Date.now() >= deadline) return false
    if (holder) await new Promise((resolve) => setTimeout(resolve, SEAL_POLL_MS))
  }
}

async function executeConversationTurn(
  input: StartConversationTurnInput,
  turnId: string,
  assertOwnership: () => Promise<void>,
  /** 收件箱里要取走的那一条；它的 id 也就是这一轮用户消息的 id。 */
  queued: { readonly id: string; readonly announce: boolean },
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
    // 先取走再预扣：两步同在这个事务里，任一步不成立就整笔回滚，那一条原样待处理。
    if (!(await consumeAgentMessage(tx, conversationId, queued.id, turnId)))
      throw new TurnStartRollback({ kind: 'withdrawn' })
    let reserved: ChatTaskReserved | undefined
    if (chatTask) {
      const reservation = await reserveChatTask({ tx, ...chatTask })
      if (reservation.kind !== 'reserved') throw new TurnStartRollback(reservation)
      reserved = reservation
    }
    if (history.length === 0) {
      await setAgentConversationTitle(tx, conversationId, owner, agentConversationTitle(text))
    }
    const userMessage = await appendAgentMessage(tx, {
      id: queued.id,
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
    if (error instanceof TurnStartRollback) return error.result
    throw error
  })
  if (written.kind !== 'reserved') return written

  await assertOwnership()
  return {
    kind: 'started',
    turn: await startAgentTurn({
      assertExecution: assertOwnership,
      withExecution: (callback) => withConversationExecution(conversationId, turnId, callback),
      conversationId,
      turnId,
      userMessageId: written.userMessageId,
      ...(queued.announce ? { queueId: queued.id } : {}),
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

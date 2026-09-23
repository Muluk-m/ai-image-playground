import type {
  AgentMode,
  AgentQueuedMessageFailure,
  AgentTurnParams,
  AgentTurnReference,
  AgentWakeSkipReason,
} from '@image-playground/shared'
import {
  AGENT_CONVERSATION_TITLE_MAX_CHARS,
  AGENT_MAX_CONSECUTIVE_WAKES,
  AGENT_QUEUE_MAX_PENDING,
  agentConversationTitle,
  agentTitleLine,
} from '@image-playground/shared'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { config } from '../../config'
import { db, schema } from '../../db/client'
import { isCapabilityEnabled } from '../capabilities'
import { askChatModel } from '../chatCompletion'
import { bffDrain } from '../drain'
import { log } from '../logger'
import type { BffTransaction, TaskReservationFailure } from '../private-overlay'
import { loadPrivateBffOverlay } from '../private-overlay'
import { isObject } from '../type-guards'
import { markAgentJobsWakeSkipped } from './background-jobs'
import {
  type ChatTaskReserved,
  chatTaskPricing,
  chatTurnSettle,
  chatTurnsBilled,
  reserveChatTask,
} from './chat-task'
import {
  type AgentOwner,
  appendAgentMessage,
  listAgentHistoryWindow,
  listAgentTurnMessages,
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
  consecutiveAgentWakes,
  consumeAgentMessage,
  failAgentMessage,
  nextAgentInboxEntry,
  pendingAgentWakes,
  type QueuedResume,
  type QueuedWake,
  skipAgentWake,
} from './inbox'
import { type RunningTurn, runningTurn } from './runningTurns'
import { agentThinking } from './thinking'
import { deliverDueAgentWakes, wakePlan } from './wake'
import {
  mergedWakePrompt,
  type WakeJob,
  wakeAuthorizationPrompt,
  wakeJobs,
  wakeReviewImageIds,
  wakeTurnPrompt,
  wakeTurnSetup,
} from './wake-prompt'

const TITLE_TIMEOUT_MS = 2_000
/** 一句标题加 JSON 外壳绰绰有余：卡得太紧回复被截断，解析不出来这一趟就白跑。 */
const TITLE_MAX_TOKENS = 64

/**
 * 首轮落库的标题就是用户那句原话，这里让小模型把它概括成一个短名字。整件事在后台做：
 * 概括要过一次上游，挡在起轮前面对话就迟迟不动。
 *
 * 只在标题仍是那句原话时才改：概括迟到、期间标题已被写成别的，那一份才是更新的意思。
 */
async function nameConversation(
  conversationId: string,
  owner: AgentOwner,
  text: string,
): Promise<void> {
  try {
    const title = await askChatModel(
      {
        model: config.agent.summaryModel,
        prompt:
          '请把下面这条用户请求概括成一个简短中文项目标题。只输出 JSON：{"title":"标题"}，标题不要标点，最多12个字。\n\n用户请求：' +
          text,
        maxTokens: TITLE_MAX_TOKENS,
        timeoutMs: TITLE_TIMEOUT_MS,
      },
      (value) =>
        isObject(value) && typeof value.title === 'string'
          ? agentTitleLine(value.title, AGENT_CONVERSATION_TITLE_MAX_CHARS)
          : null,
    )
    await setAgentConversationTitle(db, conversationId, owner, title, agentConversationTitle(text))
  } catch {
    // 概括不是对话主链路：首句标题已在事务里落库，这里失败就保留它。
  }
}

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
        : next.kind === 'resume'
          ? await executeResumeTurn(conversationId, owner, next, turnId, assertOwnership)
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
        // 这一轮放手了：排着的下一条接着开轮。队里没有待处理的，再看它提交的后台任务是不是已经
        // 全部结束、此刻才凑齐一批，是就投递唤醒接着开轮。先看队列再投递：投递要开一个事务，
        // 放手之后才进来的那条若在这期间入队，会被这里抢去开轮，它自己的请求反倒拿不到流。
        // 都没有就不再领租约——空领一次也会让刚收尾的会话在那一瞬间显得还忙，删会话之类的操作
        // 会撞上 409。
        // 队里已经有排着的，也先投递这一轮凑齐的唤醒：它并进下一条消息的轮，不再单独起一轮。
        () =>
          void nextAgentInboxEntry(conversationId)
            .then(async (waiting) => {
              if (waiting) {
                await deliverDueAgentWakes([conversationId])
                return waiting
              }
              return (await deliverDueAgentWakes([conversationId])) > 0
                ? nextAgentInboxEntry(conversationId)
                : null
            })
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
    { estimateTurnInputTokens, clarificationChainStart },
    { startAgentTurn },
    { resolveAgentMode },
    overlay,
    historyWindow,
    submittingTurn,
    plan,
    audience,
  ] = await Promise.all([
    import('./turn-input'),
    import('./turn'),
    import('./tools'),
    overlayPromise,
    // 读历史会把窗口里结束了的后台任务结算成终局：唤醒轮看到的就是它们的结果。窗口之外更老的
    // 那些不在这一趟里，由会话快照（`routes/agent.ts`）与维护任务结算。
    listAgentHistoryWindow(conversationId, owner),
    // 点名的结果卡与提交那一轮的用户原话都属于提交的那一轮，而它可能比历史窗口更老：定点取回来，
    // 在窗口里筛会静默筛不到，唤醒轮就成了「一个任务都找不到」。
    listAgentTurnMessages(conversationId, owner, [wake.turnId]),
    // 提交这一批时的改图计划：唤醒轮接着它走，不另起一份。
    wakePlan(wake.taskIds),
    // 技能与这个用户自建的模板一起取：两者都要进系统提示词，预扣也按它们算。
    import('./skills').then(async (skills) => {
      await skills.ensureAgentSkills()
      return skills.loadAgentTurnAudience(userId)
    }),
  ])
  const jobs = wakeJobs(submittingTurn, wake.taskIds)
  if (jobs.length === 0) {
    // 点名的结果卡一张都不在（那一轮没能落下结果卡就没了）：没有可看的，取走它不起轮。
    await withConversationExecution(conversationId, turnId, (tx) =>
      consumeAgentMessage(tx, conversationId, wake.id, turnId),
    )
    return { kind: 'withdrawn' }
  }
  // 用户没说话时连续自动唤醒到了上限：停下等用户，结果照常在画布上，他下次说话时智能体看得到。
  if ((await consecutiveAgentWakes(conversationId)) >= AGENT_MAX_CONSECUTIVE_WAKES)
    return skipWake(conversationId, turnId, wake, jobs, 'wake_limit')
  const setup = wakeTurnSetup(jobs)
  const mode = resolveAgentMode(setup.mode)
  const { params } = setup
  const selectedModel = agentThinking(params?.thinkingDepth).model
  const text = wakeTurnPrompt(jobs)
  const reviewImageIds = wakeReviewImageIds(jobs)
  const selectionHistoryStart = plan?.protected
    ? 0
    : clarificationChainStart(historyWindow.messages)
  const deviceId = wake.deviceId || (owner.kind === 'device' ? owner.deviceId : '')
  const pricing =
    chatTurnsBilled() && userId ? await chatTaskPricing(overlay.taskHooks, selectedModel) : null
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
          estimatedInputTokens: estimateTurnInputTokens(
            historyWindow,
            text,
            [],
            mode,
            reviewImageIds,
            params?.autoSubmit === true,
            selectionHistoryStart,
            audience,
          ),
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
  // 积分不够再起一轮：不唤醒，也不欠费。结果照常落画布，面板说明智能体没有查看。
  if (written.kind === 'insufficient_credits')
    return skipWake(conversationId, turnId, wake, jobs, 'insufficient_credits')
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
      history: historyWindow,
      text,
      references: [],
      selectionHistoryStart,
      mode,
      userId,
      deviceId,
      audience,
      ...(params ? { params } : {}),
      wake: {
        authorizationPrompt: wakeAuthorizationPrompt(submittingTurn, wake.turnId),
        ...(plan ? { plan } : {}),
        reviewImageIds,
      },
      reservedCredits: written.reserved?.reservedCredits,
      settle: chatTurnSettle(conversationId, turnId, written.reserved),
    }),
  }
}

/**
 * 不起轮就了结这条唤醒：收件箱里记成已撤回，结果卡记下没唤醒的原因。两步同在租约下的一个
 * 事务里；它若已被别处取走，就什么都不记。
 */
async function skipWake(
  conversationId: string,
  turnId: string,
  wake: QueuedWake,
  jobs: readonly WakeJob[],
  reason: AgentWakeSkipReason,
): Promise<StartConversationTurnResult> {
  await withConversationExecution(conversationId, turnId, async (tx) => {
    if (!(await skipAgentWake(tx, conversationId, wake.id))) return
    await markAgentJobsWakeSkipped(
      tx,
      conversationId,
      jobs.map((job) => job.block.job!.taskId),
      reason,
    )
  })
  log.info(
    { event: 'agent.wake_skipped', conversationId, wakeId: wake.id, reason },
    'background job wake skipped',
  )
  return { kind: 'withdrawn' }
}

/**
 * 并进用户消息这一轮的唤醒：此刻排着的全部唤醒，连同它们点名的结果与要复核的产物。
 * 点名的结果卡一张都不在时照样取走，只是不附说明。
 */
interface MergedWakes {
  readonly ids: readonly string[]
  readonly note?: { readonly text: string; readonly reviewImageIds: readonly string[] }
}

function mergeWakes(
  wakes: readonly QueuedWake[],
  /** 提交这几条唤醒的那几轮的消息：结果卡可能比历史窗口更老，只能定点取。 */
  submittingTurns: Parameters<typeof wakeJobs>[0],
): MergedWakes {
  const jobs = wakeJobs(
    submittingTurns,
    wakes.flatMap((wake) => wake.taskIds),
  )
  return {
    ids: wakes.map((wake) => wake.id),
    ...(jobs.length > 0
      ? { note: { text: mergedWakePrompt(jobs), reviewImageIds: wakeReviewImageIds(jobs) } }
      : {}),
  }
}

async function consumeMergedWakes(
  tx: BffTransaction,
  conversationId: string,
  merged: MergedWakes,
  turnId: string,
): Promise<void> {
  for (const id of merged.ids) await consumeAgentMessage(tx, conversationId, id, turnId)
}

/**
 * 中断续跑：被打断的那一轮没说完的已经丢了，再起一轮接着做，只续这一次。与唤醒一样没有用户
 * 消息可落，模型收到的是一段系统说明；创作类型与参数沿用被打断的那一轮，已提交任务记下的改图
 * 计划也接着走——已经提交过的编辑不会再提交一次；被打断那一轮提交过的任务按调用内容去重，模型
 * 再发起同样的调用时交回原任务。被打断的是唤醒轮时，输入照那一批结果取（唤醒说明、授权原文、
 * 改图计划与要复核的产物）。计费、租约与普通的轮一样。
 */
async function executeResumeTurn(
  conversationId: string,
  owner: AgentOwner,
  resume: QueuedResume,
  turnId: string,
  assertOwnership: () => Promise<void>,
): Promise<StartConversationTurnResult> {
  const userId = owner.kind === 'user' ? owner.userId : null
  const billed = isCapabilityEnabled('billing:credits')
  if (billed && owner.kind !== 'user') return { kind: 'authentication_required' }
  const overlayPromise = loadPrivateBffOverlay()
  const { wake } = resume
  // 结果卡与授权原话都属于被点名的那一轮：被打断的是唤醒轮就是提交那一批的那一轮，否则是被打断的
  // 那一轮。它可能比历史窗口更老，所以定点取而不是在窗口里筛。
  const authorizedTurnId = wake?.turnId ?? resume.interruptedTurnId
  const [
    { estimateTurnInputTokens, clarificationChainStart },
    { startAgentTurn },
    { resolveAgentMode, createSubmissionReplay },
    { resumeTurnPrompt, interruptedSubmissions },
    overlay,
    historyWindow,
    authorizedTurn,
    interruptedJobs,
    audience,
  ] = await Promise.all([
    import('./turn-input'),
    import('./turn'),
    import('./tools'),
    import('./interrupted'),
    overlayPromise,
    listAgentHistoryWindow(conversationId, owner),
    listAgentTurnMessages(conversationId, owner, [authorizedTurnId]),
    turnJobs(conversationId, resume.interruptedTurnId),
    import('./skills').then(async (skills) => {
      await skills.ensureAgentSkills()
      return skills.loadAgentTurnAudience(userId)
    }),
  ])
  const [plan, submissions] = await Promise.all([
    // 改图计划接着最近的一次提交走：被打断的是唤醒轮时，先是提交那一批时的，再是它自己提交的。
    wakePlan([...(wake?.taskIds ?? []), ...interruptedJobs]),
    interruptedSubmissions(conversationId, resume.interruptedTurnId),
  ])
  // 被打断的是唤醒轮：续跑接着处理那一批结果，创作类型、参数与要复核的产物都照唤醒轮的算法取。
  const jobs = wake ? wakeJobs(authorizedTurn, wake.taskIds) : []
  const setup = wake ? wakeTurnSetup(jobs) : resume
  const mode = resolveAgentMode(setup.mode ?? 'image')
  const { params } = setup
  const selectedModel = agentThinking(params?.thinkingDepth).model
  const text = resumeTurnPrompt(wake ? wakeTurnPrompt(jobs) : undefined)
  const reviewImageIds = wakeReviewImageIds(jobs)
  const interruptedStart = historyWindow.messages.findIndex(
    (message) => message.turnId === resume.interruptedTurnId,
  )
  const selectionHistoryStart = plan?.protected
    ? 0
    : !wake && interruptedStart >= 0
      ? clarificationChainStart(historyWindow.messages.slice(0, interruptedStart))
      : clarificationChainStart(historyWindow.messages)
  const deviceId = resume.deviceId || (owner.kind === 'device' ? owner.deviceId : '')
  const pricing =
    chatTurnsBilled() && userId ? await chatTaskPricing(overlay.taskHooks, selectedModel) : null
  const chatTask =
    pricing && userId
      ? {
          model: selectedModel,
          taskHooks: overlay.taskHooks,
          conversationId,
          turnId,
          userId,
          deviceId,
          estimatedInputTokens: estimateTurnInputTokens(
            historyWindow,
            text,
            [],
            mode,
            reviewImageIds,
            params?.autoSubmit === true,
            selectionHistoryStart,
            audience,
          ),
          pricing,
        }
      : null
  const written = await withConversationExecution(conversationId, turnId, async (tx) => {
    if (!(await consumeAgentMessage(tx, conversationId, resume.id, turnId)))
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
      // 与唤醒一样没有用户消息；界面不为它出用户气泡。
      userMessageId: `${turnId}:resume`,
      history: historyWindow,
      text,
      references: [],
      selectionHistoryStart,
      mode,
      userId,
      deviceId,
      audience,
      ...(params ? { params } : {}),
      wake: {
        // 授权原文仍是用户的原话：被打断那一轮的，唤醒轮则是提交那一批的那一轮的。
        authorizationPrompt: wakeAuthorizationPrompt(authorizedTurn, authorizedTurnId),
        ...(plan ? { plan } : {}),
        reviewImageIds,
        // 被打断那一轮已经提交的任务：同样的调用再来一次时交回它，不再提交。
        ...(submissions.length > 0 ? { replay: createSubmissionReplay(submissions) } : {}),
      },
      reservedCredits: written.reserved?.reservedCredits,
      settle: chatTurnSettle(conversationId, turnId, written.reserved),
    }),
  }
}

/** 某一轮提交过的后台任务，按提交先后。 */
async function turnJobs(conversationId: string, turnId: string): Promise<string[]> {
  const rows = await db
    .select({ taskId: schema.agent_jobs.task_id })
    .from(schema.agent_jobs)
    .where(
      and(
        eq(schema.agent_jobs.conversation_id, conversationId),
        eq(schema.agent_jobs.turn_id, turnId),
      ),
    )
    .orderBy(asc(schema.agent_jobs.submitted_at))
  return rows.map((row) => row.taskId)
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
    { estimateTurnInputTokens, clarificationChainStart },
    { startAgentTurn },
    { resolveAgentMode },
    overlay,
    historyWindow,
    pricing,
    wakes,
    audience,
  ] = await Promise.all([
    import('./turn-input'),
    import('./turn'),
    import('./tools'),
    overlayPromise,
    // 读历史会把窗口里结束了的后台任务结算成终局：并进这一轮的唤醒看到的就是它们的结果。窗口
    // 之外更老的那些不在这一趟里，由会话快照（`routes/agent.ts`）与维护任务结算。
    listAgentHistoryWindow(conversationId, owner),
    chatTurnsBilled()
      ? overlayPromise.then((it) => chatTaskPricing(it.taskHooks, selectedModel))
      : null,
    // 恰好排着的唤醒并进这一轮，不再单独起轮。
    pendingAgentWakes(conversationId),
    // 这个用户自建的模板与内置技能排在同一份清单里，所以跟着技能一起读完再估算。
    import('./skills').then(async (skills) => {
      await skills.ensureAgentSkills()
      return skills.loadAgentTurnAudience(userId)
    }),
  ])
  // 点名了哪几轮要等唤醒回来才知道，这一次查询只能串在后面；那几轮可能比历史窗口更老，一次全取回来。
  const merged = mergeWakes(
    wakes,
    wakes.length === 0
      ? []
      : await listAgentTurnMessages(conversationId, owner, [
          ...new Set(wakes.map((pending) => pending.turnId)),
        ]),
  )
  // 窗口空只说明锚点之后没有消息：压缩过的长会话窗口一样可能是空的，拿它当新会话会把用户自己
  // 改过的标题冲掉。一条都没折进摘要、窗口也空，才真是头一轮。
  const isFirstTurn = historyWindow.coveredCount === 0 && historyWindow.messages.length === 0
  const mode: AgentMode = resolveAgentMode(input.mode ?? 'image')
  const selectionHistoryStart = clarificationChainStart(historyWindow.messages)
  const chatTask =
    pricing && userId
      ? {
          model: selectedModel,
          taskHooks: overlay.taskHooks,
          conversationId,
          turnId,
          userId,
          deviceId,
          estimatedInputTokens: estimateTurnInputTokens(
            historyWindow,
            text,
            references,
            mode,
            [],
            params?.autoSubmit === true,
            selectionHistoryStart,
            audience,
          ),
          pricing,
        }
      : null
  // 并进唤醒后这一轮的输入更长，预扣按带上说明的估算。
  const mergedEstimate =
    chatTask && merged.note
      ? estimateTurnInputTokens(
          historyWindow,
          `${text}\n\n${merged.note.text}`,
          references,
          mode,
          merged.note.reviewImageIds,
          params?.autoSubmit === true,
          selectionHistoryStart,
          audience,
        )
      : null
  const storedReferences = await archiveAgentReferences(conversationId, turnId, references)

  const written = await withConversationExecution(conversationId, turnId, async (tx) => {
    // 先取走再预扣：两步同在这个事务里，任一步不成立就整笔回滚，那一条原样待处理。
    if (!(await consumeAgentMessage(tx, conversationId, queued.id, turnId)))
      throw new TurnStartRollback({ kind: 'withdrawn' })
    let reserved: ChatTaskReserved | undefined
    let merging = true
    if (chatTask) {
      let reservation = await reserveChatTask({
        tx,
        ...chatTask,
        ...(mergedEstimate === null ? {} : { estimatedInputTokens: mergedEstimate }),
      })
      // 带上唤醒的说明预扣不下，就只为用户这条消息预扣：唤醒的费用不能挡住用户的话。唤醒留在
      // 收件箱里，之后走它自己的路（积分不足时不唤醒）。被拒的预扣不留痕迹，同一事务里可以再来一次。
      if (reservation.kind === 'insufficient_credits' && mergedEstimate !== null) {
        merging = false
        reservation = await reserveChatTask({ tx, ...chatTask })
      }
      if (reservation.kind !== 'reserved') throw new TurnStartRollback(reservation)
      reserved = reservation
    }
    if (merging) await consumeMergedWakes(tx, conversationId, merged, turnId)
    if (isFirstTurn) {
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
    return {
      kind: 'reserved' as const,
      userMessageId: userMessage.id,
      reserved,
      wakeNote: merging ? merged.note : undefined,
    }
  }).catch(async (error) => {
    if (storedReferences.length) await removeAgentTurnReferences(conversationId, turnId)
    if (error instanceof TurnStartRollback) return error.result
    throw error
  })
  if (written.kind !== 'reserved') return written

  await assertOwnership()
  // 自动命名不挡对话：小模型在后台改写标题，迟到或失败都只是继续用首句那个。
  if (isFirstTurn) void nameConversation(conversationId, owner, text)
  return {
    kind: 'started',
    turn: await startAgentTurn({
      assertExecution: assertOwnership,
      withExecution: (callback) => withConversationExecution(conversationId, turnId, callback),
      conversationId,
      userMessageId: written.userMessageId,
      turnId,
      ...(queued.announce ? { queueId: queued.id } : {}),
      history: historyWindow,
      text,
      references,
      selectionHistoryStart,
      mode,
      userId,
      deviceId,
      audience,
      ...(params ? { params } : {}),
      ...(written.wakeNote ? { wakeNote: written.wakeNote } : {}),
      reservedCredits: written.reserved?.reservedCredits,
      settle: chatTurnSettle(conversationId, turnId, written.reserved),
    }),
  }
}

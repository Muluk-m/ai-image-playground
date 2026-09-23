import type {
  AgentMode,
  AgentQueuedMessageFailure,
  AgentTurnParams,
  AgentTurnReference,
  AgentWakeSkipReason,
} from '@image-playground/shared'
import { AGENT_QUEUE_MAX_PENDING } from '@image-playground/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { bffDrain } from '../drain'
import { log } from '../logger'
import type { TaskReservationFailure } from '../private-overlay'
import { markAgentJobsWakeSkipped } from './background-jobs'
import type { AgentOwner } from './conversations'
import { isSealLease, sealAbandonedTurns } from './events'
import {
  agentInstance,
  assertConversationExecution,
  ConversationExecutionLost,
  claimConversation,
  conversationExecution,
  maintainConversation,
  releaseConversation,
  type TurnExecution,
  turnExecution,
} from './execution'
import {
  consumeAgentMessage,
  failAgentMessage,
  nextAgentInboxEntry,
  type QueuedResume,
  type QueuedWake,
  skipAgentWake,
} from './inbox'
import { type RunningTurn, runningTurn } from './runningTurns'
import type { PreparedAgentTurn } from './turn'
import type { TurnPreparation } from './turn-preparation'
import { deliverDueAgentWakes } from './wake'

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

export interface KickConversationInboxOptions {
  /**
   * 刚放手一轮之后的那一次接力：顺带看看它提交的后台任务是不是此刻才凑齐一批，是就投递唤醒。
   */
  readonly deliverDueWakes?: boolean
}

/**
 * 即发即忘地接着取下一条：发起方不等它，也不因它失败而改变自己的响应，所以失败只记一条日志。
 * 排队消息的每一处「这里该有人接着开轮」都走它，错误码与日志只此一份。
 */
export function kickConversationInbox(
  conversationId: string,
  options: KickConversationInboxOptions = {},
): void {
  void pickUpNextTurn(conversationId, options).catch((err) =>
    log.error(
      { event: 'agent.inbox_drain_failed', conversationId, err },
      'queued agent message could not start a turn',
    ),
  )
}

async function pickUpNextTurn(
  conversationId: string,
  options: KickConversationInboxOptions,
): Promise<void> {
  if (options.deliverDueWakes) {
    // 这一轮放手了：排着的下一条接着开轮。队里没有待处理的，再看它提交的后台任务是不是已经
    // 全部结束、此刻才凑齐一批，是就投递唤醒接着开轮。先看队列再投递：投递要开一个事务，
    // 放手之后才进来的那条若在这期间入队，会被这里抢去开轮，它自己的请求反倒拿不到流。
    // 都没有就不再领租约——空领一次也会让刚收尾的会话在那一瞬间显得还忙，删会话之类的操作
    // 会撞上 409。
    // 队里已经有排着的，也先投递这一轮凑齐的唤醒：它并进下一条消息的轮，不再单独起一轮。
    const waiting = await nextAgentInboxEntry(conversationId)
    const delivered = await deliverDueAgentWakes([conversationId])
    if (!waiting && (delivered === 0 || !(await nextAgentInboxEntry(conversationId)))) return
  }
  await drainConversationInbox(conversationId)
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
        () => kickConversationInbox(conversationId, { deliverDueWakes: true }),
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

/** pi 的模块图有 60-90ms，`agent:chat` 关着的部署不该在启动时付：起轮准备晚到这一刻才引。 */
function turnModules() {
  return Promise.all([import('./turn-preparation'), import('./turn')])
}

/**
 * 唤醒轮：后台任务结束，智能体回来看结果。准备与计费同普通的轮（见 `turn-preparation.ts`）；
 * 这里只剩唤醒自己的规矩——没有可看的结果就取走它，到了连续上限或积分不够就跳过并记下原因。
 */
async function executeWakeTurn(
  conversationId: string,
  owner: AgentOwner,
  wake: QueuedWake,
  turnId: string,
  assertOwnership: () => Promise<void>,
): Promise<StartConversationTurnResult> {
  const execution = turnExecution(conversationId, turnId, assertOwnership)
  const [{ prepareAgentTurn }, { startAgentTurn }] = await turnModules()
  const prepared = await prepareAgentTurn({
    conversationId,
    owner,
    turnId,
    execution,
    source: { kind: 'wake', wake },
  })
  switch (prepared.kind) {
    case 'no_results':
      // 点名的结果卡一张都不在：取走它不起轮，也没有卡可记原因。
      await execution.write((tx) => consumeAgentMessage(tx, conversationId, wake.id, turnId))
      return { kind: 'withdrawn' }
    case 'wake_limit':
      return skipWake(execution, conversationId, wake, 'wake_limit')
    // 积分不够再起一轮：不唤醒，也不欠费。结果照常落画布，面板说明智能体没有查看。
    case 'insufficient_credits':
      return skipWake(execution, conversationId, wake, 'insufficient_credits')
    case 'prepared':
      return { kind: 'started', turn: await startAgentTurn(prepared.turn) }
    default:
      return prepared
  }
}

/**
 * 不起轮就了结这条唤醒：收件箱里记成已撤回，结果卡记下没唤醒的原因。两步同在租约下的一个
 * 事务里；它若已被别处取走，就什么都不记。
 */
async function skipWake(
  execution: TurnExecution,
  conversationId: string,
  wake: QueuedWake,
  reason: AgentWakeSkipReason,
): Promise<StartConversationTurnResult> {
  await execution.write(async (tx) => {
    if (!(await skipAgentWake(tx, conversationId, wake.id))) return
    await markAgentJobsWakeSkipped(tx, conversationId, wake.taskIds, reason)
  })
  log.info(
    { event: 'agent.wake_skipped', conversationId, wakeId: wake.id, reason },
    'background job wake skipped',
  )
  return { kind: 'withdrawn' }
}

/**
 * 中断续跑：被打断的那一轮没说完的已经丢了，再起一轮接着做，只续这一次。输入怎么取、计费与
 * 租约怎么走都在起轮准备里，这里没有别的规矩。
 */
async function executeResumeTurn(
  conversationId: string,
  owner: AgentOwner,
  resume: QueuedResume,
  turnId: string,
  assertOwnership: () => Promise<void>,
): Promise<StartConversationTurnResult> {
  const [{ prepareAgentTurn }, { startAgentTurn }] = await turnModules()
  const prepared = await prepareAgentTurn({
    conversationId,
    owner,
    turnId,
    execution: turnExecution(conversationId, turnId, assertOwnership),
    source: { kind: 'resume', resume },
  })
  return startPreparedTurn(prepared, startAgentTurn)
}

/**
 * 起轮准备的结果换成取件方认得的那一种。`no_results` 与 `wake_limit` 只有唤醒来源会出现，
 * 所以这里不该看见它们。
 */
async function startPreparedTurn(
  prepared: TurnPreparation,
  startAgentTurn: (turn: PreparedAgentTurn) => Promise<RunningTurn>,
): Promise<StartConversationTurnResult> {
  if (prepared.kind === 'prepared')
    return { kind: 'started', turn: await startAgentTurn(prepared.turn) }
  if (prepared.kind === 'no_results' || prepared.kind === 'wake_limit')
    throw new Error(`turn preparation refused with a wake-only outcome: ${prepared.kind}`)
  return prepared
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

/**
 * 用户消息这一轮。取历史、并进排着的唤醒、落他的原话、预扣与租约都在起轮准备里
 * （见 `turn-preparation.ts`）；这里只把收件箱那一条换成一个来源。
 */
async function executeConversationTurn(
  input: StartConversationTurnInput,
  turnId: string,
  assertOwnership: () => Promise<void>,
  /** 收件箱里要取走的那一条；它的 id 也就是这一轮用户消息的 id。 */
  queued: { readonly id: string; readonly announce: boolean },
): Promise<StartConversationTurnResult> {
  const { conversationId, owner } = input
  const [{ prepareAgentTurn }, { startAgentTurn }] = await turnModules()
  const prepared = await prepareAgentTurn({
    conversationId,
    owner,
    turnId,
    execution: turnExecution(conversationId, turnId, assertOwnership),
    source: {
      kind: 'message',
      message: {
        id: queued.id,
        clientMessageId: queued.id,
        text: input.text,
        deviceId: input.deviceId,
        references: input.references,
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.params ? { params: input.params } : {}),
      },
      announce: queued.announce,
    },
  })
  return startPreparedTurn(prepared, startAgentTurn)
}

import type {
  AgentActiveTurnView,
  AgentMessageQueuedBody,
  AgentQueuedMessageView,
  AgentTurnEvent,
} from '@image-playground/shared'
import { i18next } from '../../../i18n'
import type { AgentPanelMessage, AgentTurnFooter } from '../types'
import {
  type AgentConversationState,
  AgentRequestError,
  type AgentTurnSource,
  fetchMessages,
  fetchSubmissionReceipt,
  followTurn,
  reconcileSubmission,
} from './agentClient'
import type { TurnArtifactDelivery } from './artifactDelivery'
import { pollFollowUps, shouldPollFollowUps } from './followUps'
import { hasWaitingMessages } from './messageQueue'
import { type AgentTurnFields, applyTurnSessionEvent } from './turnSession'

const TURN_RATE_LIMITED = () => i18next.t('error.rateLimited', { ns: 'agent' })

const QUEUE_PICKUP_ATTEMPTS = 8
const QUEUE_PICKUP_DELAY_MS = 250

/** 挂上快照里的某一轮：在跑的那一轮带着快照游标续播，否则按轮标识从头要。 */
export const turnSource = (taken: AgentConversationState, turnId: string): AgentTurnSource =>
  taken.activeTurn?.turnId === turnId && taken.cursor !== undefined
    ? { turnId, cursor: taken.cursor }
    : { turnId }

/** 跟轮读写的那部分 store 状态。 */
export interface TurnFollowerState extends AgentTurnFields {
  readonly conversationId: string | null
  readonly messages: readonly AgentPanelMessage[]
  readonly turns: Readonly<Record<string, AgentTurnFooter>>
  readonly activeTurn: AgentActiveTurnView | null
  readonly queue: readonly AgentQueuedMessageView[]
  readonly error: string | null
}

/** 跟轮写回 store 的补丁；函数形式读的是写入那一刻的状态。 */
export type TurnFollowerPatch =
  | Partial<TurnFollowerState>
  | ((state: TurnFollowerState) => Partial<TurnFollowerState>)

/** 跟轮要用到的服务端接口；默认是 `agentClient` 里那几个，测试换成假的。 */
export interface TurnFollowerClient {
  readonly followTurn: typeof followTurn
  readonly fetchMessages: (conversationId: string) => Promise<AgentConversationState>
  readonly fetchSubmissionReceipt: (
    conversationId: string,
    clientMessageId: string,
    signal?: AbortSignal,
  ) => Promise<AgentMessageQueuedBody | null>
  readonly reconcileSubmission: (
    conversationId: string,
    clientMessageId: string,
    signal?: AbortSignal,
  ) => Promise<AgentMessageQueuedBody | null>
  readonly pollFollowUps: typeof pollFollowUps
}

const defaultClient: TurnFollowerClient = {
  followTurn,
  fetchMessages: (conversationId) => fetchMessages(conversationId),
  fetchSubmissionReceipt: (conversationId, clientMessageId, signal) =>
    fetchSubmissionReceipt(conversationId, clientMessageId, undefined, signal),
  reconcileSubmission,
  pollFollowUps,
}

export interface TurnFollowerDeps {
  readonly get: () => TurnFollowerState
  readonly set: (patch: TurnFollowerPatch) => void
  /** 一条事件归约进队列与面板，并做交付副作用（store 的 `apply`）。 */
  readonly apply: (
    event: AgentTurnEvent,
    pendingUserText: string | null,
    turnId: string,
    turnDelivery: TurnArtifactDelivery,
    conversationId: string,
    sent: boolean,
  ) => void
  /** 判这一轮失败：出横幅，回到 failed。 */
  readonly fail: (message?: string, thrown?: unknown) => void
  /** 换上快照，面板与后台任务一起接管；`join` 是要挂上的那一轮。 */
  readonly adoptSnapshot: (
    conversationId: string,
    taken: AgentConversationState,
    options?: { readonly join?: string },
  ) => void
  /** 读回会话历史并挂上仍在跑的那一轮。 */
  readonly openConversation: (conversationId: string, turnId?: string) => Promise<void>
  /** 挂上的轮由本标签页的运行回报唤醒时，领回它登记的阶段授权。 */
  readonly claimStageRunOrigins: (conversationId: string, turnId: string) => void
  readonly beginTurn: () => TurnArtifactDelivery
  readonly client?: Partial<TurnFollowerClient>
  /** 测试里缩短等待；默认真实计时。 */
  readonly delay?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export interface TurnFollower {
  /** 把这一轮的事件归约进面板，直到 `agentClient` 把它跟到终局。 */
  follow(
    conversationId: string,
    source: AgentTurnSource,
    pendingUserText: string | null,
    turnDelivery: TurnArtifactDelivery,
    onStarted?: (turnId: string) => Promise<void>,
    submission?: { clientMessageId: string; signal: AbortSignal },
    sent?: boolean,
  ): Promise<void>
  joinQueuedTurn(
    conversationId: string,
    taken: AgentConversationState,
    turnId: string,
    origin?: boolean,
    originTurn?: string,
  ): Promise<void>
  recoverSubmissionReceipt(
    conversationId: string,
    clientMessageId: string,
    current: () => boolean,
    signal?: AbortSignal,
  ): Promise<AgentMessageQueuedBody | null>
  /** 忙时发出的消息刚好赶上上一轮收尾、当场开了轮：那一轮收尾后要去挂下一轮。 */
  expectSuccessor(conversationId: string): void
}

const realDelay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    if (signal?.aborted) finish()
    else signal?.addEventListener('abort', finish, { once: true })
  })

/**
 * 跟轮：订阅一轮的事件流直到终局；流放弃之后按快照核对终局、按回执确认提交；
 * 一轮收尾后挂上服务端接着开的下一轮。面板怎么变由注入的 `apply` / `adoptSnapshot` 决定，
 * 这里只管什么时候跟、跟哪一轮、什么时候收场。
 */
export function createTurnFollower(deps: TurnFollowerDeps): TurnFollower {
  const { get, set, apply, fail, adoptSnapshot, openConversation, claimStageRunOrigins } = deps
  const client = { ...defaultClient, ...deps.client }
  const recoveryDelay = (signal?: AbortSignal, ms = 5_000) => (deps.delay ?? realDelay)(ms, signal)

  const followers = new Map<string, TurnArtifactDelivery>()
  const successorExpected = new Set<string>()

  const follow: TurnFollower['follow'] = async (
    conversationId,
    source,
    pendingUserText,
    turnDelivery,
    onStarted,
    submission,
    sent = Boolean(submission),
  ) => {
    const previous = followers.get(conversationId)
    // 迟到的起轮响应不能抢走切回项目后建立的新订阅。
    if (!previous || turnDelivery.isCurrent()) {
      followers.set(conversationId, turnDelivery)
      if (previous && previous !== turnDelivery) await previous.settled()
    }
    let startedCallback = onStarted
    // 即使切项目后已有新订阅，旧提交仍须读到轮标识并兑现它自己的中止请求。
    const canContinue = () =>
      !submission?.signal.aborted &&
      (Boolean(startedCallback) ||
        (followers.get(conversationId) === turnDelivery && turnDelivery.canContinue()))
    let turnId = 'turnId' in source ? source.turnId : ''
    let nextSource = source
    let pickUp = false
    let recoveredQueue: AgentMessageQueuedBody | null = null
    try {
      while (canContinue()) {
        const stream = client.followTurn(conversationId, nextSource, {
          shouldContinue: canContinue,
          onReconnectingChange: (reconnecting) => {
            if (turnDelivery.isCurrent())
              set(applyTurnSessionEvent(get(), reconnecting ? 'reportReconnect' : 'clearReconnect'))
          },
        })
        for await (const event of stream.events) {
          if (event.type === 'turnStart') turnId = event.turnId
          apply(event, pendingUserText, turnId, turnDelivery, conversationId, sent)
          if (event.type === 'turnStart') {
            await startedCallback?.(turnId)
            startedCallback = undefined
          }
        }
        const expected = stream.outcome === 'ended' && successorExpected.delete(conversationId)
        pickUp =
          stream.outcome === 'ended' &&
          turnDelivery.isCurrent() &&
          (hasWaitingMessages(get().queue) || expected)
        if (stream.outcome === 'rateLimited') {
          if (turnDelivery.isCurrent()) fail(TURN_RATE_LIMITED(), stream.lastError)
          break
        }
        if (stream.outcome !== 'gone' && stream.outcome !== 'unreachable') break
        const stillOurs = () =>
          turnDelivery.isCurrent() &&
          get().turn === 'running' &&
          (!turnId || get().activeTurn?.turnId === turnId)
        if (!stillOurs()) break
        if (!turnId && submission) {
          const receipt = await recoverSubmissionReceipt(
            conversationId,
            submission.clientMessageId,
            stillOurs,
            submission.signal,
          )
          if (!stillOurs() || submission.signal.aborted) break
          if (receipt?.state === 'consumed' && receipt.turnId) {
            turnId = receipt.turnId
            set({ activeTurn: { turnId } })
            nextSource = { turnId }
            continue
          }
          if (receipt && receipt.state !== 'cancelled') recoveredQueue = receipt
          else fail(undefined, stream.lastError)
          break
        }
        const settled = await settleFromSnapshot(conversationId, turnId)
        if (!stillOurs() || settled === 'settled') break
        if (settled === 'failed' || !turnId) {
          fail(undefined, stream.lastError)
          break
        }
        set(applyTurnSessionEvent(get(), 'reportReconnect'))
        await recoveryDelay()
        if (!stillOurs()) break
        nextSource = { turnId, cursor: stream.cursor }
      }
    } catch (thrown) {
      // 归约自己出了错：不能让面板永远停在进行中。
      if (turnDelivery.isCurrent() && get().turn === 'running') fail(undefined, thrown)
      throw thrown
    } finally {
      await turnDelivery.settled()
      if (followers.get(conversationId) === turnDelivery) followers.delete(conversationId)
    }
    if (
      turnId &&
      turnDelivery.isCurrent() &&
      get().conversationId === conversationId &&
      get().turn === 'idle' &&
      shouldPollFollowUps({ turnId, messages: get().messages, turns: get().turns })
    ) {
      const watched = conversationId
      const watchedTurn = turnId
      void client
        .pollFollowUps(watched, watchedTurn, () => get().conversationId === watched)
        .then((lines) => {
          if (!lines?.length || get().conversationId !== watched) return
          set((state) => {
            const footer = state.turns[watchedTurn]
            if (!footer) return state
            return {
              turns: { ...state.turns, [watchedTurn]: { ...footer, followUps: lines } },
            }
          })
        })
    }
    if (recoveredQueue && turnDelivery.isCurrent())
      await openConversation(conversationId, recoveredQueue.turnId)
    else if (pickUp) void followQueuedTurn(conversationId, turnId)
  }

  /**
   * 上一轮收尾后去挂服务端接着开的那一轮。它可能还差几十毫秒才登记上，所以快照里还没有新的
   * 一轮、队里又还有消息时隔一会儿再看；队里没了、或者等不到就照快照收场。
   */
  const followQueuedTurn = async (conversationId: string, endedTurnId: string) => {
    const idle = () => get().conversationId === conversationId && get().turn !== 'running'
    for (let attempt = 0; attempt < QUEUE_PICKUP_ATTEMPTS; attempt += 1) {
      if (!idle()) return
      let snapshot: AgentConversationState
      try {
        snapshot = await client.fetchMessages(conversationId)
      } catch {
        return
      }
      if (!idle()) return
      const next = snapshot.activeTurn?.turnId
      if (next && next !== endedTurnId) {
        await joinQueuedTurn(conversationId, snapshot, next)
        return
      }
      // 队里只剩没能开轮的那几条（带错误码）时不再等：它们不会被处理，照快照摆出来。
      if (!hasWaitingMessages(snapshot.queue ?? []) || attempt === QUEUE_PICKUP_ATTEMPTS - 1) {
        set({ queue: [...(snapshot.queue ?? [])] })
        return
      }
      await recoveryDelay(undefined, QUEUE_PICKUP_DELAY_MS)
    }
  }

  /**
   * 流放弃之后核对这一轮在服务端的终局：已经收尾且不算失败，就照快照摆出它的回复；服务端接着
   * 开了下一轮（排队消息、中断续跑）就挂上去。连接未知与仍在运行分开返回，调用方继续恢复，只有明确终态才收场。
   */
  const settleFromSnapshot = async (
    conversationId: string,
    turnId: string,
  ): Promise<'settled' | 'running' | 'unknown' | 'failed'> => {
    if (!turnId) return 'unknown'
    let taken: AgentConversationState
    try {
      taken = await client.fetchMessages(conversationId)
    } catch {
      return 'unknown'
    }
    const next = taken.activeTurn?.turnId
    if (next === turnId) return 'running'
    const summary = taken.turns.find((one) => one.turnId === turnId)
    // 被打断、排上中断续跑的轮不是失败，与 `apply` 处理终帧同一个口径（ADR 0006）。
    const failed =
      !summary || (summary.stopReason === 'failed' && summary.error !== 'agent_turn_interrupted')
    if (failed) return 'failed'
    if (get().conversationId !== conversationId || get().activeTurn?.turnId !== turnId)
      return 'settled'
    if (next) {
      void joinQueuedTurn(conversationId, taken, next)
      return 'settled'
    }
    adoptSnapshot(conversationId, taken)
    set({ ...applyTurnSessionEvent(get(), 'finish'), activeTurn: null, error: null })
    return 'settled'
  }

  /**
   * 挂上服务端从队里接着开的那一轮。同一个会话不走 `openConversation`：它会重置交付，把上一轮
   * 交给后台任务的占位一起收掉。
   */
  const joinQueuedTurn: TurnFollower['joinQueuedTurn'] = async (
    conversationId,
    taken,
    turnId,
    origin = false,
    originTurn,
  ) => {
    adoptSnapshot(conversationId, taken, { join: turnId })
    if (originTurn) claimStageRunOrigins(conversationId, originTurn)
    await follow(
      conversationId,
      turnSource(taken, turnId),
      null,
      deps.beginTurn(),
      undefined,
      undefined,
      origin,
    )
  }

  const recoverSubmissionReceipt: TurnFollower['recoverSubmissionReceipt'] = async (
    conversationId,
    clientMessageId,
    current,
    signal,
  ) => {
    if (current()) set(applyTurnSessionEvent(get(), 'reportReconnect'))
    let missing = 0
    try {
      while (current() && !signal?.aborted) {
        try {
          const receipt = await client.fetchSubmissionReceipt(
            conversationId,
            clientMessageId,
            signal,
          )
          if (receipt) return receipt
          if (++missing >= 3) {
            // 空回执不能证明原 POST 已结束。与入队共用锁确认终态：已接收则续接，
            // 尚未入队则留下取消记录，迟到的同 id POST 不能再开轮。
            const confirmed = await client.reconcileSubmission(
              conversationId,
              clientMessageId,
              signal,
            )
            return confirmed
          }
          // 另一执行器上的 POST 可能尚在入队前，空回执先有界复查。
          await recoveryDelay(signal, 500)
          continue
        } catch (error) {
          if (signal?.aborted) return null
          if (error instanceof AgentRequestError && error.status < 500) throw error
        }
        await recoveryDelay(signal)
      }
      return null
    } finally {
      if (current()) set(applyTurnSessionEvent(get(), 'clearReconnect'))
    }
  }

  return {
    follow,
    joinQueuedTurn,
    recoverSubmissionReceipt,
    expectSuccessor: (conversationId) => {
      successorExpected.add(conversationId)
    },
  }
}

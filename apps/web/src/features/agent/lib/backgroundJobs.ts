import type {
  AgentBackgroundJobProgress,
  AgentBackgroundJobView,
  AgentMessageView,
} from '@image-playground/shared'
import { notifyPrivateSubmissionSettled } from '../../../lib/privateOverlay'
import type { AgentPanelMessage, AgentToolMessage } from '../types'
import {
  type AgentConversationState,
  AgentRequestError,
  cancelRetry as cancelRetryRequest,
  cancelJob as requestJobCancel,
  fetchJobs as requestJobs,
  fetchMessages as requestSnapshot,
} from './agentClient'
import {
  type AgentArtifactDelivery,
  deliverable,
  type TurnArtifactDelivery,
} from './artifactDelivery'
import { agentCanvasSink } from './canvasSink'
import { agentJobUnsettled } from './jobProgress'
import { panelMessage } from './panelMessages'
import { agentDraftReservation } from './promptDraft'
import type { AgentRetryRefusal } from './retry'
import { promptAgentRecharge } from './toolFailure'

/** 后台任务问服务端的节奏。每次用时现读，所以测试调快它对已经建好的模块也作数。 */
export interface AgentJobTiming {
  /** 有没结束的后台任务时隔多久问一次结果。任务是分钟级的，几秒的延迟看不出来。 */
  pollIntervalMs: number
  /**
   * 服务端唤醒智能体起的那一轮还没登记上时，隔多久再看一次。
   * 头一次读快照就会让服务端当场起轮，所以通常第二次就看得到。
   */
  wakePickupDelayMs: number
}

const REAL_TIMING: AgentJobTiming = { pollIntervalMs: 3_000, wakePickupDelayMs: 500 }

/** 不另说时的那一份节奏。 */
export const AGENT_JOB_TIMING: AgentJobTiming = { ...REAL_TIMING }

/** 测试注入点：面板那一条只有一份 store，调不了构造参数，所以就地改这一份。不传恢复真实节奏。 */
export function setAgentJobTimingForTesting(timing?: Partial<AgentJobTiming>): void {
  Object.assign(AGENT_JOB_TIMING, REAL_TIMING, timing)
}

/** 找唤醒轮最多看这么多次。 */
const WAKE_PICKUP_ATTEMPTS = 8

/**
 * 交出一张卡时，它的产出落在画布哪里。三种交接点各说一种，交出之后占位就归这个模块，
 * 由它在任务结束时落图或标错。
 */
export type AgentJobPlacement =
  /**
   * 轮里提交的：这次调用在本轮占的位不随轮收掉，移交给任务。出图模式下生成工具当场提交，
   * 起跑那一刻还不知道会不会真提交（额度、余额都可能让它退回拟稿），所以起跑时没占位，
   * 位在这里补上——`reserve` 按 messageId 幂等，占过的走到这里是空操作。
   */
  | { readonly kind: 'handOff'; readonly turn: TurnArtifactDelivery }
  /** 确认草稿当场提交：拟稿那一步不出图也不占位，位要在这时候才占。 */
  | { readonly kind: 'reserve' }
  /** 单张重试：结果落回这个已经在画布上的失败占位，而不是另占新位。 */
  | { readonly kind: 'adopt'; readonly placeholderId?: string }

/** 面板那一侧：后台任务只经这几个口子读写它，别的都在模块里面。 */
export interface AgentJobSession {
  /** 面板上此刻的消息。 */
  messages(): readonly AgentPanelMessage[]
  /** 这个会话还是面板上开着的那个。 */
  isCurrent(conversationId: string): boolean
  /** 这个会话开着，而且没有在跑的轮：唤醒轮只在这种时候去挂。 */
  isIdle(conversationId: string): boolean
  /** 就地换掉一张结果卡（任务结算、排着的重试轮到）。 */
  replaceCard(card: AgentToolMessage): void
  /** 面板上还没有的重试记录（别的设备点的）补在末尾。 */
  appendCards(cards: readonly AgentToolMessage[]): void
  /** 服务端报的任务进度。 */
  reportProgress(messageId: string, progress: AgentBackgroundJobProgress): void
  /** 一次重试被拒后盖在云端失败占位上的那一层。 */
  coverRefusal(placeholderId: string, refusal: AgentRetryRefusal): void
  /** 换上这份快照；带 `join` 时连同挂上那一轮。 */
  adopt(
    conversationId: string,
    snapshot: AgentConversationState,
    options?: { readonly join?: string },
  ): Promise<void>
}

export interface AgentBackgroundJobsOptions {
  readonly delivery: AgentArtifactDelivery
  readonly session: AgentJobSession
  readonly fetchJobs?: (conversationId: string) => Promise<readonly AgentBackgroundJobView[]>
  readonly fetchSnapshot?: (conversationId: string) => Promise<AgentConversationState>
  readonly timing?: AgentJobTiming
}

/**
 * 这个会话的后台任务。一个任务的一生——交接、轮询、结算、产物交付、唤醒接轮——都在这里，
 * 调用方只交出一张卡。
 */
export interface AgentBackgroundJobs {
  /**
   * 交出一张刚提交的结果卡，之后一直等它的结果。给回来的已经是终局（重复确认、别的设备
   * 已经补上）就当场交付一次：轮询只认没结束的卡，这一步不做，占的位会一直转圈。
   */
  track(conversationId: string, card: AgentToolMessage, placement: AgentJobPlacement): void
  /**
   * 换上一段历史之后接管它的任务：交出去的把手上已经结算的当场交付，还没结束的接着等。
   */
  resume(conversationId: string, messages: readonly AgentPanelMessage[]): void
  /**
   * 单独取消这张结果卡提交的任务；服务端按原桶退回，卡随即换成取消后的结局。还在重试队列里
   * 排着的重试记录也走这里：撤回它，失败占位保持原来那次失败。
   */
  cancel(conversationId: string, messageId: string): Promise<void>
  /**
   * 交付换代（切会话、新建会话、停止撞上 404 后按历史重来）：移交出去的把手全部作废，
   * 它们占的位就地收掉，守候也停下。之后再结算的任务按当时的画布现开把手。
   */
  reset(): void
}

/**
 * 这个任务结束后服务端会不会唤醒智能体：失败一律唤醒（被取消的不算），成功只在提交时要求了
 * 复核。只按错误码与复核标记判断，不读服务端文字。
 */
const wakesAgent = (result: AgentBackgroundJobView['result']) =>
  result.status === 'failed'
    ? result.errorCode !== 'cancelled'
    : result.status === 'succeeded' && result.job?.review === true

/**
 * 快照里有结果卡记下了「没有唤醒智能体」，面板上的那张还没有：服务端没起唤醒轮，而是跳过了它
 * （积分不足、连续唤醒到了上限）。面板据此换上快照，卡上才说得出智能体为什么没回来。
 */
function wakeSkipNews(
  snapshot: readonly AgentMessageView[],
  shown: readonly AgentPanelMessage[],
): boolean {
  const skipped = new Set(
    snapshot.flatMap((message) =>
      message.content.some((block) => block.type === 'toolResult' && block.wakeSkipped)
        ? [message.id]
        : [],
    ),
  )
  return shown.some(
    (message) => message.kind === 'tool' && skipped.has(message.id) && !message.wakeSkipped,
  )
}

export function createAgentBackgroundJobs({
  delivery,
  session,
  fetchJobs = requestJobs,
  fetchSnapshot = requestSnapshot,
  timing = AGENT_JOB_TIMING,
}: AgentBackgroundJobsOptions): AgentBackgroundJobs {
  /**
   * 后台任务的交付把手，按结果卡的 messageId 索引。工具在轮里收尾时占的位移交到这里，
   * 任务结束时由它落图；刷新后读回的任务没有把手，结束时现开一个（占位已随刷新收掉，产物就近落）。
   */
  const handles = new Map<string, TurnArtifactDelivery>()
  /** 正在等结果的那一次守候；换一次就是一个新对象，旧的循环看见不是自己就退出。 */
  let watch: { readonly conversationId: string } | null = null
  /** 正在找唤醒轮的那一次。 */
  let wakeWatch: { readonly conversationId: string } | null = null

  const pending = () => session.messages().some(agentJobUnsettled)

  /**
   * 重试记录的交付把手：它不占新位，结果落回用户点重试的那个失败占位。刷新之后读回来的重试
   * 没有把手，凭记录上的占位 id 现开一个。
   */
  const retryHandle = (card: AgentToolMessage): TurnArtifactDelivery | undefined => {
    const placeholderId = card.retryOf?.placeholderId
    if (!placeholderId) return undefined
    const handle = delivery.beginTurn()
    handle.adopt(card.id, [placeholderId])
    return handle
  }

  /** 重试被中止：失败占位回到原来那次失败，用户还能再点。 */
  const failureCodeOf = (card: AgentToolMessage) => {
    if (!card.retryOf || card.errorCode !== 'cancelled') return card.errorCode
    const origin = session.messages().find((message) => message.id === card.retryOf?.messageId)
    return origin?.kind === 'tool' ? origin.errorCode : card.errorCode
  }

  /**
   * 排着的重试轮到时被拒（积分不够、没登录……）：本机占位由 `markFailed` 写上新的码；云端占位
   * 本机改不了，照点重试当场被拒时那样盖一层，压在它此刻挂着的那次生成上——之前有过提交了的
   * 重试就是最近那一条的任务，否则是原失败卡的任务。
   */
  const coverRefusedSlot = (card: AgentToolMessage) => {
    const placeholderId = card.retryOf?.placeholderId
    const code = card.errorCode
    if (!placeholderId || card.job || !code || code === 'cancelled') return
    const slot = [...session.messages()]
      .reverse()
      .find(
        (message): message is AgentToolMessage =>
          message.kind === 'tool' &&
          message.job !== undefined &&
          (message.retryOf
            ? message.retryOf.placeholderId === placeholderId
            : message.id === card.retryOf?.messageId),
      )
    session.coverRefusal(
      placeholderId,
      slot?.job ? { code, generationId: slot.job.taskId } : { code },
    )
  }

  /** 一个任务的终局卡落画布：交出去的占位还在就落进占位，否则按锚点或视野落。 */
  const deliver = (card: AgentToolMessage) => {
    // 任务的结算（成功扣费、失败退回）此刻已经发生，顶栏余额跟着刷新。
    notifyPrivateSubmissionSettled()
    const handle = handles.get(card.id) ?? retryHandle(card) ?? delivery.beginTurn()
    handles.delete(card.id)
    // 取消是用户自己的决定，不留失败占位：云端项目在取消时同样收掉预留的位置。重试记录例外：
    // 中止一次重试，失败占位回到原来那次失败，用户还能再点。
    if (card.status === 'failed' && card.errorCode === 'cancelled' && !card.retryOf)
      handle.discard(card.id)
    else if (card.status === 'failed') {
      const code = failureCodeOf(card)
      handle.failed(card.id, card.message, code)
      promptAgentRecharge(code)
      coverRefusedSlot(card)
    } else if (deliverable(card)) handle.enqueue(card)
    else handle.discard(card.id)
    void handle.settled()
  }

  /**
   * 排着的重试轮到了：服务端已经提交它的任务。卡换成在跑，失败占位重新转圈，任务结束时结果落回
   * 那个占位。预扣此刻发生，顶栏余额跟着刷新。
   */
  const startQueuedRetry = (card: AgentToolMessage) => {
    session.replaceCard(card)
    notifyPrivateSubmissionSettled()
    const placeholderId = card.retryOf?.placeholderId
    if (!placeholderId || handles.has(card.id)) return
    void agentCanvasSink()?.revive?.([placeholderId])
    const handle = delivery.beginTurn()
    handle.adopt(card.id, [placeholderId])
    handles.set(card.id, handle)
  }

  /** 一个后台任务到了终局：结果卡换成终局，产物按产物交付落画布，失败就在占位上标错。 */
  const settle = (job: AgentBackgroundJobView, conversationId: string) => {
    const shown = session.messages().find((message) => message.id === job.messageId)
    if (shown?.kind !== 'tool' || !agentJobUnsettled(shown)) return
    if (job.progress) session.reportProgress(job.messageId, job.progress)
    if (job.result.status === shown.status) return
    const card = panelMessage(job.messageId, job.turnId, 'assistant', [job.result])
    if (card.kind !== 'tool') return
    if (agentJobUnsettled(card)) {
      startQueuedRetry(card)
      return
    }
    session.replaceCard(card)
    deliver(card)
    if (wakesAgent(job.result)) void followWakeTurn(conversationId)
  }

  /**
   * 别的设备（或别的标签页）在这个会话里点的重试：面板上还没有它的记录，照服务端给的样子补在
   * 末尾。还在跑的接着等，结束时照常落回它指着的那个占位；已经结束的只补记录，产物由点重试的
   * 那台设备落过了。
   */
  const adoptRetryRecords = (jobs: readonly AgentBackgroundJobView[]) => {
    const shown = new Set(session.messages().map((message) => message.id))
    const records = jobs.flatMap((job) => {
      if (!job.result.retryOf || shown.has(job.messageId)) return []
      const card = panelMessage(job.messageId, job.turnId, 'assistant', [job.result])
      return card.kind === 'tool' ? [card] : []
    })
    if (records.length) session.appendCards(records)
  }

  /**
   * 这个会话还有没结束的后台任务就一直等它们的结果，直到都结束或者切走。不跟轮：轮早已收尾，
   * 结果要等任务自己跑完；刷新、换设备、服务重启之后读回来的也走这一条。
   */
  const startWatch = (conversationId: string) => {
    if (watch?.conversationId === conversationId) return
    const token = { conversationId }
    watch = token
    const watching = () => session.isCurrent(conversationId) && watch === token
    void (async () => {
      try {
        // 先问一次再等：刷新后读回的卡立刻就有阶段与已用时间，不必空等一个间隔。
        while (watching() && pending()) {
          let jobs: readonly AgentBackgroundJobView[] = []
          try {
            jobs = await fetchJobs(conversationId)
          } catch {
            // 一次没问到不要紧，下一次接着问。
          }
          if (!watching()) return
          adoptRetryRecords(jobs)
          for (const job of jobs) settle(job, conversationId)
          if (!pending()) return
          await new Promise((resolve) => setTimeout(resolve, timing.pollIntervalMs))
        }
      } finally {
        if (watch === token) watch = null
      }
    })()
  }

  /**
   * 后台任务结束后服务端唤醒智能体起的那一轮：面板空着就挂上去。一直没看到进行中的轮、快照里
   * 却多了面板没有的消息，说明那一轮在两次查看之间已经跑完，照快照摆出来。同一批里还有没结束的
   * 任务时服务端先不唤醒，看不到就作罢：下一个结束的任务还会再来找一次。
   */
  const followWakeTurn = async (conversationId: string) => {
    if (wakeWatch?.conversationId === conversationId) return
    const token = { conversationId }
    wakeWatch = token
    const idle = () => session.isIdle(conversationId) && wakeWatch === token
    try {
      for (let attempt = 0; attempt < WAKE_PICKUP_ATTEMPTS; attempt += 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, attempt === 0 ? 0 : timing.wakePickupDelayMs),
        )
        if (!idle()) return
        let snapshot: AgentConversationState
        try {
          snapshot = await fetchSnapshot(conversationId)
        } catch {
          return
        }
        if (!idle()) return
        const next = snapshot.activeTurn?.turnId
        if (next) {
          wakeWatch = null
          await session.adopt(conversationId, snapshot, { join: next })
          return
        }
        const shown = new Set(session.messages().map((message) => message.id))
        if (
          snapshot.messages.some((message) => !shown.has(message.id)) ||
          wakeSkipNews(snapshot.messages, session.messages())
        ) {
          await session.adopt(conversationId, snapshot)
          return
        }
      }
    } finally {
      if (wakeWatch === token) wakeWatch = null
    }
  }

  const reserveSlot = (
    conversationId: string,
    card: AgentToolMessage,
    placement: AgentJobPlacement,
  ): TurnArtifactDelivery => {
    if (placement.kind === 'handOff') {
      placement.turn.reserve(card.id, agentDraftReservation(card, conversationId))
      return placement.turn.handOff(card.id)
    }
    const handle = delivery.beginTurn()
    if (placement.kind === 'reserve')
      handle.reserve(card.id, agentDraftReservation(card, conversationId))
    else if (placement.placeholderId) handle.adopt(card.id, [placement.placeholderId])
    return handle
  }

  return {
    track(conversationId, card, placement) {
      if (!agentJobUnsettled(card)) {
        deliver(card)
        return
      }
      // 排在别的重试后面的那条还没提交、没扣费：占位保持失败并标着排队中，轮到时才占。
      if (card.status === 'submitted' && !handles.has(card.id))
        handles.set(card.id, reserveSlot(conversationId, card, placement))
      startWatch(conversationId)
    },

    resume(conversationId, messages) {
      for (const message of messages)
        if (message.kind === 'tool' && !agentJobUnsettled(message) && handles.has(message.id))
          deliver(message)
      if (messages.some(agentJobUnsettled)) startWatch(conversationId)
    },

    async cancel(conversationId, messageId) {
      const message = session.messages().find((one) => one.id === messageId)
      if (message?.kind !== 'tool' || !agentJobUnsettled(message)) return
      if (!message.job && !(message.retryOf && message.status === 'queued')) return
      if (message.retryOf) {
        // 重试记录走重试自己的中止：按原桶退回，云端占位回到原来那次失败，用户还能再点。
        try {
          await cancelRetryRequest(conversationId, message.id)
        } catch (thrown) {
          // 409：它恰好已经结束，下面照常读回终局。
          if (!(thrown instanceof AgentRequestError && thrown.status === 409)) throw thrown
        }
        const jobs = await fetchJobs(conversationId)
        if (!session.isCurrent(conversationId)) return
        for (const one of jobs) settle(one, conversationId)
        return
      }
      if (!message.job) return
      const job = await requestJobCancel(conversationId, message.job.taskId)
      if (!session.isCurrent(conversationId)) return
      settle(job, conversationId)
    },

    reset() {
      for (const [messageId, handle] of handles) {
        handle.discard(messageId)
        void handle.settled()
      }
      handles.clear()
      watch = null
    },
  }
}

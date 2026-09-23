import type {
  AgentActiveTurnView,
  AgentBackgroundJobProgress,
  AgentBackgroundJobView,
  AgentConversationView,
  AgentMessageView,
  AgentMode,
  AgentQueuedMessageView,
  AgentThinkingDepth,
  AgentToolErrorCode,
  AgentTurnEvent,
  AgentTurnReference,
  ProjectKind,
} from '@image-playground/shared'
import {
  AGENT_IMAGE_MAX_N,
  AGENT_QUEUE_MAX_PENDING,
  PROJECT_NAME_MAX_LENGTH,
} from '@image-playground/shared'
import { create } from 'zustand'
import { requireAccount } from '../../auth/loginPrompt'
import { i18next } from '../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../lib/apiProfiles'
import { AGENT_CONVERSATION_KEY, safeLocalStorage, scopedStorageName } from '../../lib/authScope'
import { isClientCapabilityEnabled } from '../../lib/clientCapabilities'
import { notifyPrivateSubmissionSettled } from '../../lib/privateOverlay'
import { useStore } from '../../store'
import { cloudProjectsEnabled, getCloudProject } from '../canvas/lib/projectClient'
import {
  bindNewCanvasWorkspace,
  currentCanvasWorkspace,
  selectCanvasWorkspace,
} from '../canvas/lib/workspaces'
import {
  currentCanvasProject,
  restoreCloudProject,
  useCanvasProjectStore,
} from '../canvas/projectStore'
import { clampPanelWidth, PANEL_WIDTH } from './agentStyles'
import {
  AgentRequestError,
  type AgentTurnSource,
  abortTurn,
  cancelRetry as cancelRetryRequest,
  confirmToolPrompt,
  fetchConversations,
  fetchJobs,
  fetchMessages,
  followTurn,
  interjectQueuedMessage,
  interjectTurn,
  removeConversation,
  cancelJob as requestJobCancel,
  retryToolCall,
  type StartTurnOutcome,
  startTurn,
  withdrawQueuedMessage,
} from './lib/agentClient'
import {
  createArtifactDelivery,
  deliverable,
  type TurnArtifactDelivery,
} from './lib/artifactDelivery'
import { agentCanvasSink, onAgentCanvasSinkChange } from './lib/canvasSink'
import { bindNewAgentDraft } from './lib/drafts'
import {
  addQueuedMessage,
  hasWaitingMessages,
  reduceMessageQueue,
  removeQueuedMessage,
  returnQueuedToDraft,
} from './lib/messageQueue'
import {
  answerableClarificationId,
  dropUnsettledMessages,
  panelMessage,
  panelStateFromHistory,
  reconcileToolCard,
  reduceAgentPanelEvent,
} from './lib/panelMessages'
import {
  createProjectConversation,
  currentProjectDraft,
  type DeleteProjectPanel,
  deleteProject,
  type ShowProjectPanel,
  saveCurrentProject,
  showProject,
} from './lib/projectLifecycle'
import { agentDraftReservation } from './lib/promptDraft'
import { agentRetryRemaining, agentRetrySlotTasks } from './lib/retry'
import { agentToolFailureText } from './lib/toolFailure'
import { toAgentTurnParams } from './lib/turnParams'
import type {
  AgentPanelMessage,
  AgentPanelTab,
  AgentToolMessage,
  AgentTurnFooter,
  AgentTurnStatus,
} from './types'

// 文案按调用时取，不在模块加载时定死：切语言之后新出的报错要跟着换语言。
const TURN_FAILED = () => i18next.t('error.turnFailed', { ns: 'agent' })
const TURN_RATE_LIMITED = () => i18next.t('error.rateLimited', { ns: 'agent' })
const CONVERSATION_UNREADABLE = () => i18next.t('error.conversationUnreadable', { ns: 'agent' })
const CONVERSATION_GONE = () => i18next.t('error.conversationGone', { ns: 'agent' })

/** 登录后 scope 会变，所以每次现算，不缓存。 */
const conversationKey = () => scopedStorageName(AGENT_CONVERSATION_KEY)

const THINKING_DEPTH_KEY = 'image-playground-agent-thinking-depth'
function readThinkingDepth(): AgentThinkingDepth {
  const value = safeLocalStorage.getItem(THINKING_DEPTH_KEY)
  return value === 'fast' || value === 'deep' ? value : 'medium'
}

/**
 * 出图模式（生成工具拟好稿当场提交，不逐张等确认）。与思考档位同样是本机偏好：
 * 它换掉的是用户那道花钱闸门，跨会话记住才不用每批都重开，但也绝不跟着账号同步。
 */
const AUTO_SUBMIT_KEY = 'image-playground-agent-auto-submit'

/** 重试被拒时盖在失败占位上的那一层：新的码，以及它盖的是哪一次云端生成。 */
export interface AgentRetryRefusal {
  readonly code: AgentToolErrorCode
  readonly generationId?: string
}

/**
 * 确认一张草稿卡的结局。界面只按它在卡上说一句话、给一个出路（ADR 0006），不读服务端文字：
 *
 * - `refused`：服务端拒了这次提交（积分不够、没登录、参数不成立……），码即出路。
 * - `gone`：这条消息不在了（换了账号、会话已删）。
 * - `notConfirmable`：它已经不是待确认的草稿（别处确认过、草稿过期）。
 * - `failed`：请求本身没成（断网、超时、服务端出错），原样再点一次即可。
 */
export type AgentPromptConfirmResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason: 'refused' | 'gone' | 'notConfirmable' | 'failed'
      readonly code?: AgentToolErrorCode
    }

export interface AgentState {
  thinkingDepth: AgentThinkingDepth
  setThinkingDepth(depth: AgentThinkingDepth): void
  /**
   * 出图模式：生成工具拟好稿当场提交，不再逐张等确认（`AgentTurnParams.autoSubmit`）。
   * 与思考档位同属本机偏好，起轮时随参数快照送到服务端。
   */
  autoSubmit: boolean
  setAutoSubmit(autoSubmit: boolean): void
  /**
   * 这个会话此刻在做什么。输入框上的开关是它的唯一写入口，草稿仍然负责持久化；
   * 放在 store 里是因为「代用户发一轮」的入口（澄清作答等）看不见输入框，
   * 而 mode 不落库，服务端也无从替它们补。
   */
  mode: AgentMode
  setMode(mode: AgentMode): void
  open: boolean
  tab: AgentPanelTab
  conversationId: string | null
  conversations: AgentConversationView[]
  messages: AgentPanelMessage[]
  turns: Record<string, AgentTurnFooter>
  turn: AgentTurnStatus
  stopping: boolean
  /** 跟着的那一轮断了流、正在续播：面板顶部据此出断线提示。 */
  reconnecting: boolean
  /** 正在跟的那一轮；中止与插话都指向它。 */
  activeTurn: AgentActiveTurnView | null
  /** 智能体忙时发出、服务端还排着的消息，按处理顺序。 */
  queue: AgentQueuedMessageView[]
  error: string | null
  loaded: boolean
  historyLoading: boolean
  historyFailed: boolean
  /** 对话面板宽度（CSS 像素），用户拖过就记住。 */
  panelWidth: number
  /**
   * 后台任务此刻的进度（排队还是在生成、何时受理），按结果卡的 messageId 索引。
   * 来自服务端的任务表，所以刷新、换设备后看到的阶段与已用时间不变。
   */
  jobProgress: Readonly<Record<string, AgentBackgroundJobProgress>>
  /**
   * 工具起跑的时刻，按结果卡的 messageId 索引：服务端盖在 `toolStart` 上的那个，旧记录才是本机
   * 看到的时刻。服务端还没报后台任务进度时拿它算已用时间。
   */
  toolStartedAt: Readonly<Record<string, number>>
  /**
   * 一次重试被拒（积分不够、没登录……）后，那个失败占位该给的出路，按占位 id 索引。本机占位
   * 直接把码写进占位；云端占位的失败状态归服务端，本机不能改写云端文档，只能在这里盖一层。
   * 带着被拒时占位所属的云端任务：占位被别处的重试换过之后，这一层不再作数。
   */
  retryRefusals: Readonly<Record<string, AgentRetryRefusal>>
  /**
   * 待确认的草稿卡上，用户此刻改到的提示词，按那张卡的 messageId 索引。卡会随着切页签、
   * 收起面板卸载，改过的字放在这里才不会没了；确认成交或换会话时清掉。
   * 缺席即还没动过，界面显示模型拟的那份。
   */
  promptDrafts: Readonly<Record<string, string>>

  setOpen(open: boolean): void
  setTab(tab: AgentPanelTab): void
  setPanelWidth(width: number): void
  /** 读回会话列表与上次那个会话的消息，并挂回仍在进行的那一轮。 */
  load(): Promise<void>
  refreshConversations(): Promise<void>
  selectConversation(conversationId: string): Promise<void>
  deleteConversation(conversationId: string): Promise<void>
  startNewConversation(): void
  retryHistory(): Promise<void>
  /** 画布类型建项目时定死：视频入口建视频画布，其余入口建图片画布。 */
  createProject(kind?: ProjectKind): Promise<boolean>
  selectProject(projectId: string, isCurrent?: () => boolean): Promise<boolean>
  deleteProject(projectId: string): Promise<boolean>
  /** onAccepted 只在服务端接收后触发，输入框此时才清掉已提交草稿。 */
  send(
    text: string,
    references?: readonly AgentTurnReference[],
    onAccepted?: () => void,
    /** 这一轮要创作什么；缺席即沿用会话此刻的那个。插话不带它——mode 是起轮时定下的。 */
    mode?: AgentMode,
  ): Promise<void | 'cancelled'>
  abort(): Promise<void>
  /** 撤回一条排队消息；它已经被处理了就照实说。 */
  withdrawQueued(queueId: string): Promise<void>
  /** 把一条排队消息升级为插话：插进正在跑的那一轮，在它下一个动作边界生效。 */
  interjectQueued(queueId: string): Promise<void>
  /** 产物没能落下去（画布已离开等）时，由用户把那张结果卡的产出放进画布。 */
  placeOnCanvas(messageId: string): Promise<void>
  /**
   * 单独取消这张结果卡提交的后台任务；服务端按原桶退回，卡随即换成取消后的结局。
   * 还在重试队列里排着的重试记录也走这里：撤回它，失败占位保持原来那次失败。
   */
  cancelJob(messageId: string): Promise<void>
  /**
   * 单张重试：按那张失败卡起跑时的参数重出一张，不经对话模型。结果落回 `placeholderId`
   * 那个失败占位；对话末尾追加一条重试记录。`generationId` 是云端占位此刻挂着的那次生成。
   * 占位真正换成生成中（云端项目要等文档拉回来）之后才兑现，调用方据此一直按住按钮。
   * 排在别的重试后面时当场兑现：占位保持失败并标着排队中。兑现为 false 即这次重试被拒。
   */
  retry(messageId: string, placeholderId?: string, generationId?: string): Promise<boolean>
  /**
   * 一键补齐：这张失败卡在画布上剩下的失败占位（还没有排着、在跑或已补上的重试）逐个重试。
   * 第一条当场提交，其余进服务端的重试队列依次执行。
   */
  retryRemaining(messageId: string): Promise<void>
  /** 草稿卡上改提示词：只留在本机，确认时才提交。 */
  setPromptDraft(messageId: string, prompt: string): void
  /**
   * 确认一张草稿卡：把这份提示词原样交给服务端提交生成任务，面板换上提交之后的那张卡，
   * 并接着等任务结果。重复点击、多标签页同时确认都只会有一个任务。
   */
  confirmPrompt(messageId: string, prompt: string): Promise<AgentPromptConfirmResult>
  /**
   * 按面板上的先后逐张确认所有待确认草稿。一张被拒（余额不够、没登录）就停下，
   * 不刷出一串同样的错；返回停下之前成交的张数与那个出路。
   */
  confirmAllPrompts(): Promise<{ confirmed: number; failure: AgentPromptConfirmResult | null }>
}

const failPatch = (state: AgentState, message = TURN_FAILED()) => ({
  turn: 'failed' as const,
  stopping: false,
  activeTurn: null,
  error: message,
  messages: dropUnsettledMessages(state.messages),
})

let pendingSeq = 0
const PENDING_PREFIX = 'pending_'

const PANEL_WIDTH_KEY = 'image-playground.agent_panel_width'

/**
 * 用第一句话给项目起的名字。
 *
 * 附图的哨兵（`[image N]`）是发给模型的坐标，不是用户写的字，留在标题里只会变成
 * 「把[image 1]改成」这种半截话。全是附图、一个字没写的那条返回空串，标题仍等 Agent 取。
 *
 * 直接删而不是换成空格：中文句子里哨兵两侧没有空格，换成空格会留下「把 和 换成」；
 * 英文句子里它本来就被空格夹着，删掉多出来的那个由后面的合并收掉。
 */
function firstMessageTitle(text: string): string {
  return text
    .replace(/\[image\s+\d+\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PROJECT_NAME_MAX_LENGTH)
}

/** 有没结束的后台任务时隔多久问一次结果。任务是分钟级的，几秒的延迟看不出来。 */
const DEFAULT_JOB_POLL_MS = 3_000
let jobPollMs = DEFAULT_JOB_POLL_MS

/** 测试注入点；不传恢复真实节奏。 */
export function setAgentJobPollIntervalForTesting(ms?: number): void {
  jobPollMs = ms ?? DEFAULT_JOB_POLL_MS
}

/** 还在跑的后台任务，或还在重试队列里排着的重试：两者都要接着问服务端。 */
const unsettled = (message: AgentPanelMessage) =>
  message.kind === 'tool' && (message.status === 'submitted' || message.status === 'queued')

const hasPendingJobs = (messages: readonly AgentPanelMessage[]) => messages.some(unsettled)

/** 上一轮收尾后找服务端接着开的那一轮：最多看这么多次，每次隔这么久。 */
const QUEUE_PICKUP_ATTEMPTS = 8
const QUEUE_PICKUP_DELAY_MS = 250
/** 停止请求没拿到响应时，连同第一次一共发这么多次。 */
const STOP_ATTEMPTS = 3

/**
 * 后台任务结束、服务端会唤醒智能体再起一轮时，去找那一轮：最多看这么多次，每次隔这么久。
 * 头一次读快照就会让服务端当场起轮，所以通常第二次就看得到。
 */
const WAKE_PICKUP_ATTEMPTS = 8
const DEFAULT_WAKE_PICKUP_DELAY_MS = 500
let wakePickupDelayMs = DEFAULT_WAKE_PICKUP_DELAY_MS

/** 测试注入点；不传恢复真实节奏。 */
export function setAgentWakePickupDelayForTesting(ms?: number): void {
  wakePickupDelayMs = ms ?? DEFAULT_WAKE_PICKUP_DELAY_MS
}

/**
 * 服务端在起轮时把首句标题交给小模型改写，改完不另行通知。首轮收尾读到的多半还是首句，
 * 所以隔这么久再补拉一次会话列表，项目名跟着一起更新。只补这一次，不轮询。
 */
const DEFAULT_TITLE_REWRITE_MS = 4_000
let titleRewriteMs = DEFAULT_TITLE_REWRITE_MS

/** 测试注入点；不传恢复真实节奏。 */
export function setAgentTitleRewriteDelayForTesting(ms?: number): void {
  titleRewriteMs = ms ?? DEFAULT_TITLE_REWRITE_MS
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

function readPanelWidth(): number {
  const raw = Number(safeLocalStorage.getItem(PANEL_WIDTH_KEY))
  return Number.isFinite(raw) && raw > 0 ? clampPanelWidth(raw) : PANEL_WIDTH
}

export const useAgentStore = create<AgentState>((set, get) => {
  const delivery = createArtifactDelivery((messageId, status) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.kind === 'tool' && message.id === messageId
          ? { ...message, delivery: status }
          : message,
      ),
    })),
  )
  // 画布挂回来（切回创作模式、画布重挂）就把它不在时错过的产物补落上去。
  onAgentCanvasSinkChange((sink) => {
    if (sink) void delivery.redeliverUnavailable(get().messages)
  })

  /**
   * 后台任务的交付把手，按结果卡的 messageId 索引。工具在轮里收尾时占的位移交到这里，
   * 任务结束时由它落图；刷新后读回的任务没有把手，结束时现开一个（占位已随刷新收掉，产物就近落）。
   */
  const jobDeliveries = new Map<string, TurnArtifactDelivery>()
  /** 正在等结果的那一次守候；换一次就是一个新对象，旧的循环看见不是自己就退出。 */
  let jobWatch: { readonly conversationId: string } | null = null

  /**
   * 交付换代（切会话、新建会话、停止撞上 404 后按历史重来）时，移交出去的把手全部作废：它们
   * 占的位就地收掉，守候也停下。之后再结算的任务按当时的画布现开把手，不会拿着旧一代的来源
   * 落成「画布已离开」。
   */
  const resetDelivery = () => {
    for (const [messageId, handle] of jobDeliveries) {
      handle.discard(messageId)
      void handle.settled()
    }
    jobDeliveries.clear()
    jobWatch = null
    return delivery.reset()
  }

  /**
   * 重试记录的交付把手：它不占新位，结果落回用户点重试的那个失败占位。刷新之后读回来的重试
   * 没有把手，凭记录上的占位 id 现开一个。
   */
  const retryDelivery = (card: AgentToolMessage): TurnArtifactDelivery | undefined => {
    const placeholderId = card.retryOf?.placeholderId
    if (!placeholderId) return undefined
    const handle = delivery.beginTurn()
    handle.adopt(card.id, [placeholderId])
    return handle
  }

  /** 重试被中止：失败占位回到原来那次失败，用户还能再点。 */
  const failureCodeOf = (card: AgentToolMessage) => {
    if (!card.retryOf || card.errorCode !== 'cancelled') return card.errorCode
    const origin = get().messages.find((message) => message.id === card.retryOf?.messageId)
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
    const { messages } = get()
    const slot = [...messages]
      .reverse()
      .find(
        (message): message is AgentToolMessage =>
          message.kind === 'tool' &&
          message.job !== undefined &&
          (message.retryOf
            ? message.retryOf.placeholderId === placeholderId
            : message.id === card.retryOf?.messageId),
      )
    const refusal: AgentRetryRefusal = slot?.job
      ? { code, generationId: slot.job.taskId }
      : { code }
    set((state) => ({ retryRefusals: { ...state.retryRefusals, [placeholderId]: refusal } }))
  }

  /**
   * 别的设备（或别的标签页）在这个会话里点的重试：面板上还没有它的记录，照服务端给的样子补在
   * 末尾。还在跑的接着等，结束时照常落回它指着的那个占位；已经结束的只补记录，产物由点重试的
   * 那台设备落过了。
   */
  const adoptRetryRecords = (jobs: readonly AgentBackgroundJobView[]) => {
    const shown = new Set(get().messages.map((message) => message.id))
    const records = jobs.flatMap((job) => {
      if (!job.result.retryOf || shown.has(job.messageId)) return []
      const card = panelMessage(job.messageId, job.turnId, 'assistant', [job.result])
      return card.kind === 'tool' ? [card] : []
    })
    if (records.length) set((state) => ({ messages: [...state.messages, ...records] }))
  }

  /**
   * 排着的重试轮到了：服务端已经提交它的任务。卡换成在跑，失败占位重新转圈，任务结束时结果落回
   * 那个占位。预扣此刻发生，顶栏余额跟着刷新。
   */
  const startQueuedRetry = (card: AgentToolMessage) => {
    set((state) => ({
      messages: state.messages.map((message) => (message.id === card.id ? card : message)),
    }))
    notifyPrivateSubmissionSettled()
    const placeholderId = card.retryOf?.placeholderId
    if (!placeholderId || jobDeliveries.has(card.id)) return
    void agentCanvasSink()?.revive?.([placeholderId])
    const handle = delivery.beginTurn()
    handle.adopt(card.id, [placeholderId])
    jobDeliveries.set(card.id, handle)
  }

  /** 一个后台任务到了终局：结果卡换成终局，产物按产物交付落画布，失败就在占位上标错。 */
  const settleJob = (job: AgentBackgroundJobView, conversationId: string) => {
    const shown = get().messages.find((message) => message.id === job.messageId)
    if (shown?.kind !== 'tool' || !unsettled(shown)) return
    const { progress } = job
    if (progress)
      set((state) => ({ jobProgress: { ...state.jobProgress, [job.messageId]: progress } }))
    if (job.result.status === shown.status) return
    const card = panelMessage(job.messageId, job.turnId, 'assistant', [job.result])
    if (card.kind !== 'tool') return
    if (card.status === 'submitted' || card.status === 'queued') {
      startQueuedRetry(card)
      return
    }
    set((state) => ({
      messages: state.messages.map((message) => (message.id === card.id ? card : message)),
    }))
    deliverJob(card)
    if (wakesAgent(job.result)) void followWakeTurn(conversationId)
  }

  /** 后台任务的终局卡落画布：交出去的占位还在就落进占位，否则按锚点或视野落。 */
  const deliverJob = (card: AgentToolMessage) => {
    // 任务的结算（成功扣费、失败退回）此刻已经发生，顶栏余额跟着刷新。
    notifyPrivateSubmissionSettled()
    const handle = jobDeliveries.get(card.id) ?? retryDelivery(card) ?? delivery.beginTurn()
    jobDeliveries.delete(card.id)
    // 取消是用户自己的决定，不留失败占位：云端项目在取消时同样收掉预留的位置。重试记录例外：
    // 中止一次重试，失败占位回到原来那次失败，用户还能再点。
    if (card.status === 'failed' && card.errorCode === 'cancelled' && !card.retryOf)
      handle.discard(card.id)
    else if (card.status === 'failed') {
      handle.failed(card.id, card.message, failureCodeOf(card))
      coverRefusedSlot(card)
    } else if (deliverable(card)) handle.enqueue(card)
    else handle.discard(card.id)
    void handle.settled()
  }

  /**
   * 这个会话还有没结束的后台任务就一直等它们的结果，直到都结束或者切走。不跟轮：轮早已收尾，
   * 结果要等任务自己跑完；刷新、换设备、服务重启之后读回来的也走这一条。
   */
  const watchJobs = (conversationId: string) => {
    if (jobWatch?.conversationId === conversationId) return
    const token = { conversationId }
    jobWatch = token
    const watching = () => get().conversationId === conversationId && jobWatch === token
    void (async () => {
      try {
        // 先问一次再等：刷新后读回的卡立刻就有阶段与已用时间，不必空等一个间隔。
        while (watching() && hasPendingJobs(get().messages)) {
          let jobs: readonly AgentBackgroundJobView[] = []
          try {
            jobs = await fetchJobs(conversationId)
          } catch {
            // 一次没问到不要紧，下一次接着问。
          }
          if (!watching()) return
          adoptRetryRecords(jobs)
          for (const job of jobs) settleJob(job, conversationId)
          if (!hasPendingJobs(get().messages)) return
          await new Promise((resolve) => setTimeout(resolve, jobPollMs))
        }
      } finally {
        if (jobWatch === token) jobWatch = null
      }
    })()
  }

  /**
   * 先把事件归约进面板，再做交付副作用。归约是纯的（见 `lib/panelMessages`），
   * 这里只补轮自己的状态：哪一轮在跑、跑完是回 idle 还是判失败。
   */
  const apply = (
    event: AgentTurnEvent,
    pendingUserText: string | null,
    turnId: string,
    turnDelivery: TurnArtifactDelivery,
    conversationId: string,
  ) => {
    if (turnDelivery.isCurrent()) {
      const queue = reduceMessageQueue(get().queue, event)
      if (queue !== get().queue) set({ queue: [...queue] })
    }
    if (turnDelivery.isCurrent())
      set((state) => {
        const panel = reduceAgentPanelEvent(state, event, { turnId, pendingUserText })
        // 已用时间的起点取服务端盖在 toolStart 上的时刻：刷新、换设备重放出来的是同一个数。
        // 旧记录没有它才退回本机看到的时刻，续播重放同一条时不重新计时。
        if (
          event.type === 'toolStart' &&
          (event.startedAt !== undefined || state.toolStartedAt[event.messageId] === undefined)
        )
          return {
            ...panel,
            toolStartedAt: {
              ...state.toolStartedAt,
              [event.messageId]: event.startedAt ?? Date.now(),
            },
          }
        if (event.type === 'turnStart') return { ...panel, activeTurn: { turnId: event.turnId } }
        if (event.type !== 'turnEnd') return panel
        // 被打断、已经排上中断续跑的轮不是失败：不出失败横幅，续上的那一轮随后开始（ADR 0006）。
        if (event.stopReason === 'failed' && event.error !== 'agent_turn_interrupted')
          return { ...failPatch(state), turns: panel.turns }
        return { ...panel, turn: 'idle' as const, stopping: false, activeTurn: null }
      })
    // 扣费在轮与工具各自收尾时发生，顶栏余额属于用户而不属于某个项目：切了项目之后
    // 迟到的结算也要刷新，所以放在 `isCurrent()` 之外。没有私有 overlay 时是空操作。
    if (event.type === 'turnEnd' || event.type === 'toolEnd') notifyPrivateSubmissionSettled()
    // 工具一起跑画布就占好位、镜头跟过去；产物到了落进这些位，没跑成就在原地标错。
    if (event.type === 'toolStart' && event.outputCount) {
      turnDelivery.reserve(event.messageId, {
        // 数量来自服务端；按协议上限收口，坏值不会在画布上铺出一片空框。
        count: Math.min(AGENT_IMAGE_MAX_N, event.outputCount),
        media: event.toolName === 'generateVideo' ? 'video' : 'image',
        title: event.title,
        conversationId,
        ...(event.anchorObjectId ? { anchorObjectId: event.anchorObjectId } : {}),
      })
    }
    if (event.type === 'toolEnd') {
      // 交付拿的是与面板上同一张卡：投递前后不会出现第二种产物清单。
      const card = panelMessage(event.messageId, turnId, 'assistant', [
        { ...event, type: 'toolResult' },
      ])
      // 后台任务：占的位不随这一轮收掉，交给任务，等它结束再落。
      if (event.status === 'submitted') {
        if (!jobDeliveries.has(event.messageId)) {
          // 出图模式下生成工具当场提交，起跑那一刻还不知道会不会真提交（额度、余额都可能
          // 让它退回拟稿），所以 `toolStart` 不带张数、没占位，位要在这里补上。
          // `reserve` 按 messageId 幂等：起跑时已经占过的调用走到这里是空操作。
          if (card.kind === 'tool')
            turnDelivery.reserve(event.messageId, agentDraftReservation(card, conversationId))
          jobDeliveries.set(event.messageId, turnDelivery.handOff(event.messageId))
        }
        watchJobs(conversationId)
      } else if (event.status === 'failed' && card.kind === 'tool')
        turnDelivery.failed(event.messageId, event.message, card.errorCode)
      else if (card.kind === 'tool' && deliverable(card)) turnDelivery.enqueue(card)
      else turnDelivery.discard(event.messageId)
    }
  }

  const fail = (message?: string) => set((state) => failPatch(state, message))

  const followers = new Map<string, TurnArtifactDelivery>()

  /** 把这一轮的事件归约进面板，直到 `agentClient` 把它跟到终局。 */
  const follow = async (
    conversationId: string,
    source: AgentTurnSource,
    pendingUserText: string | null,
    turnDelivery: TurnArtifactDelivery,
    onStarted?: (turnId: string) => Promise<void>,
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
      Boolean(startedCallback) ||
      (followers.get(conversationId) === turnDelivery && turnDelivery.canContinue())
    let turnId = 'turnId' in source ? source.turnId : ''
    const stream = followTurn(conversationId, source, {
      shouldContinue: canContinue,
      onReconnectingChange: (reconnecting) => {
        if (turnDelivery.isCurrent()) set({ reconnecting })
      },
    })
    let pickUp = false
    try {
      for await (const event of stream.events) {
        if (event.type === 'turnStart') turnId = event.turnId
        apply(event, pendingUserText, turnId, turnDelivery, conversationId)
        if (event.type === 'turnStart') {
          await startedCallback?.(turnId)
          startedCallback = undefined
        }
      }
      // 这一轮收了尾，排着的下一条由服务端当场开轮：挂到那一轮上去。
      const expected = successorExpected.delete(conversationId)
      pickUp =
        stream.outcome === 'ended' &&
        turnDelivery.isCurrent() &&
        (hasWaitingMessages(get().queue) || expected)
      if (stream.outcome === 'rateLimited') {
        if (turnDelivery.isCurrent()) fail(TURN_RATE_LIMITED())
      } else if (stream.outcome === 'gone' || stream.outcome === 'unreachable') {
        // 轮没了或者一直接不上：面板还停在进行中就得给个交代。
        if (turnDelivery.isCurrent() && get().turn === 'running') fail()
      }
    } catch (thrown) {
      // 归约自己出了错：不能让面板永远停在进行中。
      if (turnDelivery.isCurrent() && get().turn === 'running') fail()
      throw thrown
    } finally {
      await turnDelivery.settled()
      if (followers.get(conversationId) === turnDelivery) followers.delete(conversationId)
    }
    if (pickUp) void followQueuedTurn(conversationId, turnId)
  }

  /** 忙时发出的消息刚好赶上上一轮收尾、当场开了轮：那一轮收尾后要去挂下一轮。 */
  const successorExpected = new Set<string>()

  /**
   * 上一轮收尾后去挂服务端接着开的那一轮。它可能还差几十毫秒才登记上，所以快照里还没有新的
   * 一轮、队里又还有消息时隔一会儿再看；队里没了、或者等不到就照快照收场。
   */
  const followQueuedTurn = async (conversationId: string, endedTurnId: string) => {
    const idle = () => get().conversationId === conversationId && get().turn !== 'running'
    for (let attempt = 0; attempt < QUEUE_PICKUP_ATTEMPTS; attempt += 1) {
      if (!idle()) return
      let snapshot: Awaited<ReturnType<typeof fetchMessages>>
      try {
        snapshot = await fetchMessages(conversationId)
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
      await new Promise((resolve) => setTimeout(resolve, QUEUE_PICKUP_DELAY_MS))
    }
  }

  /**
   * 后台任务结束后服务端唤醒智能体起的那一轮：面板空着就挂上去。一直没看到进行中的轮、快照里
   * 却多了面板没有的消息，说明那一轮在两次查看之间已经跑完，照快照摆出来。同一批里还有没结束的
   * 任务时服务端先不唤醒，看不到就作罢：下一个结束的任务还会再来找一次。
   */
  let wakeWatch: { readonly conversationId: string } | null = null
  const followWakeTurn = async (conversationId: string) => {
    if (wakeWatch?.conversationId === conversationId) return
    const token = { conversationId }
    wakeWatch = token
    const idle = () =>
      get().conversationId === conversationId && get().turn !== 'running' && wakeWatch === token
    try {
      for (let attempt = 0; attempt < WAKE_PICKUP_ATTEMPTS; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 0 : wakePickupDelayMs))
        if (!idle()) return
        let snapshot: Awaited<ReturnType<typeof fetchMessages>>
        try {
          snapshot = await fetchMessages(conversationId)
        } catch {
          return
        }
        if (!idle()) return
        const next = snapshot.activeTurn?.turnId
        if (next) {
          wakeWatch = null
          await joinQueuedTurn(conversationId, snapshot, next)
          return
        }
        const shown = new Set(get().messages.map((message) => message.id))
        if (
          snapshot.messages.some((message) => !shown.has(message.id)) ||
          wakeSkipNews(snapshot.messages, get().messages)
        ) {
          const history = panelStateFromHistory(snapshot)
          const before = new Map(get().messages.map((message) => [message.id, message]))
          set({
            ...history,
            messages: history.messages.map((message) =>
              reconcileToolCard(before.get(message.id), message),
            ),
          })
          return
        }
      }
    } finally {
      if (wakeWatch === token) wakeWatch = null
    }
  }

  /**
   * 挂上服务端从队里接着开的那一轮。同一个会话不走 `openConversation`：它会重置交付，把上一轮
   * 交给后台任务的占位一起收掉。历史照快照换上，已经落过的产物保留交付状态；快照里已经结算的
   * 后台任务当场交付，还没结束的继续轮询。
   */
  const joinQueuedTurn = async (
    conversationId: string,
    snapshot: Awaited<ReturnType<typeof fetchMessages>>,
    turnId: string,
  ) => {
    const shown = new Map(get().messages.map((message) => [message.id, message]))
    const history = panelStateFromHistory(snapshot)
    const messages = history.messages.map((message) =>
      reconcileToolCard(shown.get(message.id), message),
    )
    set({
      ...history,
      messages,
      queue: [...(snapshot.queue ?? [])],
      turn: 'running',
      stopping: false,
      reconnecting: false,
      error: null,
      activeTurn: { turnId },
    })
    for (const message of messages)
      if (message.kind === 'tool' && !unsettled(message) && jobDeliveries.has(message.id))
        deliverJob(message)
    if (hasPendingJobs(messages)) watchJobs(conversationId)
    const cursor = snapshot.activeTurn?.turnId === turnId ? snapshot.cursor : undefined
    await follow(
      conversationId,
      cursor === undefined ? { turnId } : { turnId, cursor },
      null,
      delivery.beginTurn(),
    )
  }

  /**
   * 读回会话历史并挂上仍在跑的那一轮。切会话、以及起轮撞上别的标签页时走的都是这一条。
   * `turnId` 是起轮的 409 给出的兜底：历史里的 activeTurn 更新，但那一轮可能在这次读取之前
   * 刚好跑完——续播端点对已经结束的轮同样重放，用户照样看得到它的内容。
   */
  const openConversation = async (conversationId: string, turnId?: string) => {
    const isCurrent = resetDelivery()
    const same = get().conversationId === conversationId
    set({
      conversationId,
      // 换会话：草稿卡上改过的字跟着那个会话走，不带进新的。
      ...(!same ? { messages: [], turns: {}, queue: [], promptDrafts: {} } : {}),
      error: null,
      turn: 'idle',
      stopping: false,
      reconnecting: false,
      activeTurn: null,
      historyLoading: true,
      historyFailed: false,
    })
    selectCanvasWorkspace(conversationId)
    let state: Awaited<ReturnType<typeof fetchMessages>>
    try {
      state = await fetchMessages(conversationId)
      if (!isCurrent()) return
    } catch (thrown) {
      if (!isCurrent()) return
      // 只有服务端明说「没有」或「不是你的」才忘掉会话：其它失败（旧 bundle 打新服务端的 400、
      // 5xx、断网）里会话还在，忘掉它等于把用户的历史无声弄丢，报错让用户知道是读不到。
      const gone =
        thrown instanceof AgentRequestError && (thrown.status === 404 || thrown.status === 403)
      if (!gone) set({ historyLoading: false, historyFailed: true })
      const project = currentCanvasProject()
      if (gone && project?.conversationId === conversationId) {
        try {
          await useCanvasProjectStore.getState().update(project.id, { conversationId: null })
          if (!isCurrent()) return
          useCanvasProjectStore.getState().activate(project.id)
          set({
            historyLoading: false,
            historyFailed: false,
            conversationId: null,
            messages: [],
            turns: {},
            queue: [],
            turn: 'idle',
            stopping: false,
            activeTurn: null,
            error: CONVERSATION_GONE(),
          })
        } catch {
          if (isCurrent()) {
            set({ historyLoading: false, historyFailed: true })
            fail(CONVERSATION_UNREADABLE())
          }
        }
      } else if (gone) get().startNewConversation()
      else fail(CONVERSATION_UNREADABLE())
      return
    }
    const shown = new Map(get().messages.map((message) => [message.id, message]))
    const history = panelStateFromHistory(state)
    set({
      historyLoading: false,
      historyFailed: false,
      ...history,
      // 重读同一个会话（重试读取、409 兜底）时慢一步的历史里草稿还没改写：确认过的那张不回退。
      messages: history.messages.map((message) =>
        reconcileToolCard(shown.get(message.id), message),
      ),
      queue: [...(state.queue ?? [])],
    })
    void delivery.restore(get().messages)
    if (hasPendingJobs(get().messages)) watchJobs(conversationId)
    const active = state.activeTurn?.turnId ?? turnId
    if (!active) return
    set({ turn: 'running', error: null, activeTurn: { turnId: active } })
    const turnDelivery = delivery.beginTurn()
    // 快照先行、增量接在它的游标之后。游标只对快照里那一轮成立：409 兜底给的轮可能已经跑完，
    // 它在游标之前，只能按轮从头重放。
    const cursor = state.activeTurn?.turnId === active ? state.cursor : undefined
    await follow(
      conversationId,
      cursor === undefined ? { turnId: active } : { turnId: active, cursor },
      null,
      turnDelivery,
    )
  }

  /**
   * 停止请求没拿到响应（超时、断网）时重发同一个请求：服务端那一刻可能已经撤下了排队消息，
   * 只在响应里交还，重发拿得回同一批。服务端明确答复的错误（例如 404）不重发。
   */
  const abortWithRetry = async (conversationId: string, turnId: string) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await abortTurn(conversationId, turnId)
      } catch (error) {
        if (error instanceof AgentRequestError || attempt >= STOP_ATTEMPTS) throw error
      }
    }
  }

  // 发送请求尚未返回轮标识时，也必须记住用户的中止意图。
  let pendingStart: { cancelled: boolean; delivery: TurnArtifactDelivery } | null = null
  const requestAbort = async (conversationId: string, turnId: string) => {
    const current = () =>
      get().conversationId === conversationId && get().activeTurn?.turnId === turnId
    // 退回的排队消息属于按停止时的这个项目：请求期间切走了，也得落回它自己的输入框，不能落进
    // 切过去的那个项目。
    const draft = currentProjectDraft(conversationId)
    try {
      if (current()) set({ stopping: true, error: null })
      const returned = await abortWithRetry(conversationId, turnId)
      // 停止时还没处理的排队消息被服务端退回：放回输入框，由用户改了再发或删掉。
      if (returned.length) {
        draft.update((before) => returnQueuedToDraft(before, returned))
        if (get().conversationId === conversationId)
          set((state) => ({
            queue: state.queue.filter((one) => !returned.some((back) => back.id === one.id)),
          }))
      }
    } catch (error) {
      if (!current()) return
      // 轮可能恰好结束；读回事实后再决定是否报错，不能把 404 当成中止成功。
      if (error instanceof AgentRequestError && error.status === 404) {
        try {
          const history = await fetchMessages(conversationId)
          if (!current()) return
          if (!history.activeTurn) {
            resetDelivery()
            set({
              turn: 'idle',
              stopping: false,
              reconnecting: false,
              activeTurn: null,
              error: null,
              ...panelStateFromHistory(history),
            })
            void delivery.restore(get().messages)
            if (hasPendingJobs(get().messages)) watchJobs(conversationId)
            return
          }
        } catch {
          /* 保留在运行的轮，让用户重试。 */
        }
      }
      if (current()) set({ stopping: false, error: i18next.t('error.stopFailed', { ns: 'agent' }) })
    }
  }

  /** 起轮这一刻的参数快照：轮跑到一半用户改了 chip，改的是下一轮，不该追改这一轮。 */
  const currentTurnParams = () => {
    const { params, settings } = useStore.getState()
    const model = clientProfileToApiProfile(getActiveApiProfile(settings)).model
    return {
      ...toAgentTurnParams(params, model, get().autoSubmit),
      thinkingDepth: get().thinkingDepth,
    }
  }

  /** 智能体忙时发的话进服务端的排队列表，当前回复结束后按顺序处理。 */
  const queueMessage = async (
    conversationId: string,
    active: AgentActiveTurnView | null,
    text: string,
    references: readonly AgentTurnReference[],
    onAccepted: (() => void) | undefined,
    mode: AgentMode,
    clarificationAnswer: boolean,
  ) => {
    const current = () => get().conversationId === conversationId
    try {
      const outcome = await startTurn(
        conversationId,
        text,
        references,
        currentTurnParams(),
        mode,
        undefined,
        undefined,
        clarificationAnswer,
      )
      if (outcome.kind === 'queued' && outcome.body.state === 'cancelled') {
        // 服务端说它已不在队里（没能开轮被退回、或被别的设备撤回）：这句话没有被收下，草稿留着。
        if (current()) set({ error: i18next.t('error.queueFailed', { ns: 'agent' }) })
        return
      }
      if (outcome.kind === 'alreadyRunning') {
        // 老服务端没有排队：忙时照旧是插话。
        await interjectTurn(conversationId, active?.turnId ?? outcome.turnId, text, references)
      } else if (
        outcome.kind === 'frames' ||
        (outcome.kind === 'queued' && outcome.body.state === 'consumed')
      ) {
        // 上一轮刚好收尾，这句话已经开了新的一轮；那条流不在这里读，上一轮收尾后去挂它。
        successorExpected.add(conversationId)
        if (outcome.kind === 'frames') void outcome.frames.return(undefined)
      }
      onAccepted?.()
      if (!current()) return
      set((state) => ({
        error: null,
        ...(outcome.kind === 'queued' &&
        (outcome.body.state === 'pending' || outcome.body.state === 'failed')
          ? { queue: addQueuedMessage(state.queue, outcome.body.queued) }
          : {}),
      }))
    } catch (thrown) {
      if (!current()) return
      const code = thrown instanceof AgentRequestError ? thrown.code : undefined
      set({
        error:
          code === 'queue_full'
            ? i18next.t('error.queueFull', { ns: 'agent', count: AGENT_QUEUE_MAX_PENDING })
            : code === 'invalid_selection'
              ? i18next.t('error.invalidSelection', { ns: 'agent' })
              : code === 'invalid_reference'
                ? i18next.t('error.invalidReference', { ns: 'agent' })
                : i18next.t('error.queueFailed', { ns: 'agent' }),
      })
    }
  }

  let conversationListRevision = 0
  let changingProject = false
  const changeProject = async (action: () => Promise<boolean>) => {
    if (changingProject) return false
    changingProject = true
    try {
      return await action()
    } finally {
      changingProject = false
    }
  }
  /** 展示项目时属于面板自己的那几步；次序归 `projectLifecycle`。 */
  const showPanel: ShowProjectPanel = {
    resetDelivery: () => void resetDelivery(),
    reset: (project) =>
      set({
        conversationId: project.conversationId,
        messages: [],
        turns: {},
        queue: [],
        promptDrafts: {},
        turn: 'idle',
        stopping: false,
        reconnecting: false,
        activeTurn: null,
        error: null,
        historyFailed: false,
        historyLoading: false,
        loaded: true,
        tab: 'chat',
        open: true,
      }),
    open: (conversationId) => void openConversation(conversationId),
  }
  const createProject = async (reuseEmpty = true, kind: ProjectKind = 'image') => {
    const saved = await saveCurrentProject(get().conversationId)
    if (!saved.ok) throw new Error(saved.reason)
    const current = currentCanvasProject()
    const { draft, unsent } = currentProjectDraft(get().conversationId).getSnapshot()
    // 重复点击不制造空壳；有引用、草稿、画布或正在提交的内容都必须新建。
    if (
      reuseEmpty &&
      current?.kind === kind &&
      !current.conversationId &&
      !current.hasContent &&
      !current.customName &&
      get().turn !== 'running' &&
      !get().messages.length &&
      !currentCanvasWorkspace().doc.elements.length &&
      !draft.prompt.trim() &&
      !draft.references.length &&
      !unsent
    ) {
      await useCanvasProjectStore.getState().update(current.id, { workspaceOpened: true })
      showProject(current, showPanel)
      return true
    }
    const project = await useCanvasProjectStore.getState().create(kind)
    showProject(project, showPanel)
    return true
  }
  /** 删除时属于面板的那两步，外加它此刻的两件事实。 */
  const deletePanel: DeleteProjectPanel = {
    get conversationId() {
      return get().conversationId
    },
    get running() {
      return get().turn === 'running'
    },
    replaceCurrent: async () => void (await createProject(false)),
    forgetConversation: (conversationId) =>
      set((state) => ({
        conversations: state.conversations.filter((one) => one.id !== conversationId),
      })),
  }

  return {
    open: true,
    tab: 'chat',
    conversationId: null,
    conversations: [],
    messages: [],
    turns: {},
    queue: [],
    turn: 'idle',
    stopping: false,
    reconnecting: false,
    activeTurn: null,
    error: null,
    loaded: false,
    historyLoading: false,
    historyFailed: false,
    panelWidth: readPanelWidth(),
    jobProgress: {},
    toolStartedAt: {},
    retryRefusals: {},
    promptDrafts: {},
    mode: 'image',
    setMode: (mode) => {
      if (get().mode !== mode) set({ mode })
    },
    thinkingDepth: readThinkingDepth(),
    setThinkingDepth: (thinkingDepth) => {
      safeLocalStorage.setItem(THINKING_DEPTH_KEY, thinkingDepth)
      set({ thinkingDepth })
    },
    autoSubmit: safeLocalStorage.getItem(AUTO_SUBMIT_KEY) === '1',
    setAutoSubmit: (autoSubmit) => {
      safeLocalStorage.setItem(AUTO_SUBMIT_KEY, autoSubmit ? '1' : '0')
      set({ autoSubmit })
    },

    setOpen: (open) => set({ open }),
    setTab: (tab) => set({ tab }),
    setPanelWidth: (width) => {
      const next = clampPanelWidth(width)
      safeLocalStorage.setItem(PANEL_WIDTH_KEY, String(next))
      set({ panelWidth: next })
    },

    async load() {
      if (get().loaded) return
      set({ loaded: true })
      const conversationId = safeLocalStorage.getItem(conversationKey())
      await Promise.all([
        get().refreshConversations(),
        ...(conversationId ? [openConversation(conversationId)] : []),
      ])
    },

    async refreshConversations() {
      const revision = conversationListRevision
      try {
        const conversations = await fetchConversations()
        if (changingProject || revision !== conversationListRevision) return
        set({ conversations })
        if (useCanvasProjectStore.getState().loaded)
          await useCanvasProjectStore
            .getState()
            .importConversations(
              conversations,
              () => !changingProject && revision === conversationListRevision,
            )
      } catch {
        // 列表读不回来不该拖垮面板，留着上一份。
      }
    },

    async selectConversation(conversationId) {
      if (get().turn === 'running') return
      const project = useCanvasProjectStore
        .getState()
        .projects.find((one) => one.conversationId === conversationId)
      if (project) {
        await get().selectProject(project.id)
        return
      }
      safeLocalStorage.setItem(conversationKey(), conversationId)
      await openConversation(conversationId)
    },

    async deleteConversation(conversationId) {
      if (get().turn === 'running' && get().conversationId === conversationId) return
      try {
        await removeConversation(conversationId)
      } catch {
        return
      }
      set((state) => ({
        conversations: state.conversations.filter((one) => one.id !== conversationId),
      }))
      if (get().conversationId === conversationId) get().startNewConversation()
    },

    startNewConversation() {
      if (useCanvasProjectStore.getState().loaded) {
        void get().createProject()
        return
      }
      resetDelivery()
      selectCanvasWorkspace(null)
      safeLocalStorage.removeItem(conversationKey())
      set({
        conversationId: null,
        messages: [],
        turns: {},
        queue: [],
        promptDrafts: {},
        error: null,
        turn: 'idle',
        stopping: false,
        reconnecting: false,
        activeTurn: null,
        historyLoading: false,
        historyFailed: false,
      })
    },

    async retryHistory() {
      if (get().historyLoading) return
      const id = get().conversationId
      if (id) await openConversation(id)
      else {
        set({ loaded: false })
        await get().load()
      }
    },

    async createProject(kind) {
      return changeProject(async () => {
        try {
          return await createProject(true, kind)
        } catch {
          useStore.getState().showToast(i18next.t('project.createFailed', { ns: 'agent' }), 'error')
          return false
        }
      })
    },

    async selectProject(projectId, isCurrent = () => true) {
      return changeProject(async () => {
        const scope = scopedStorageName('canvas')
        let project = useCanvasProjectStore.getState().projects.find((one) => one.id === projectId)
        if (!project) return false
        if (!(await saveCurrentProject(get().conversationId)).ok) {
          useStore.getState().showToast(i18next.t('project.saveFailed', { ns: 'agent' }), 'error')
          return false
        }
        if (!isCurrent()) return false
        try {
          if (project.cloud?.revision && cloudProjectsEnabled() && navigator.onLine !== false) {
            const remote = await getCloudProject(project.id, AbortSignal.timeout(10000))
            if (!isCurrent() || scopedStorageName('canvas') !== scope) return false
            project = await restoreCloudProject(remote)
            if (!isCurrent() || scopedStorageName('canvas') !== scope) return false
            const refreshed = project
            useCanvasProjectStore.setState((state) => ({
              projects: state.projects.map((one) => (one.id === refreshed.id ? refreshed : one)),
            }))
          }
          await useCanvasProjectStore.getState().update(project.id, { workspaceOpened: true })
        } catch {
          useStore.getState().showToast(i18next.t('project.openFailed', { ns: 'agent' }), 'error')
          return false
        }
        if (!isCurrent()) return false
        showProject(project, showPanel)
        return true
      })
    },

    async deleteProject(projectId) {
      return changeProject(async () => {
        // 成对的两次自增作废在途的会话列表：删之前发出的那一份不能把项目重新导回来。
        conversationListRevision += 1
        try {
          const result = await deleteProject(projectId, deletePanel)
          if (result.ok) return true
          // 项目本来就不在了，没什么好说的；其余按「在忙」与「没删成」两句文案分。
          if (result.reason !== 'not_found')
            useStore
              .getState()
              .showToast(
                result.reason === 'busy'
                  ? i18next.t('project.deleteBusy', { ns: 'agent' })
                  : i18next.t('project.deleteFailed', { ns: 'agent' }),
                'error',
              )
          return false
        } finally {
          conversationListRevision += 1
        }
      })
    },

    async send(text, references = [], onAccepted, mode = get().mode) {
      if (changingProject || get().historyLoading || get().historyFailed || get().stopping) return
      const trimmed = text.trim()
      if (!trimmed) return
      // 计费部署的起轮要账号（BFF 在 `/api/agent/turns` 上直接 401）：先弹登录框，
      // 别把这句话上屏再被打回。没开积分计费的部署照旧按 deviceId 放匿名设备对话过。
      if (isClientCapabilityEnabled('billing:credits') && !requireAccount()) return

      const active = get().activeTurn
      const conversationId = get().conversationId
      // 末尾还有没作答的澄清：这句话就是在回答它（卡片与输入框同一个口径），服务端把它排在队首。
      const clarificationAnswer = answerableClarificationId(get().messages) !== null
      if (get().turn === 'running' && conversationId) {
        await queueMessage(
          conversationId,
          active,
          trimmed,
          references,
          onAccepted,
          mode,
          clarificationAnswer,
        )
        return
      }
      if (get().turn === 'running') return

      // 首轮才会定标题、才会有新会话进列表；之后每轮再拉一次是白拉。
      const sourceProject = currentCanvasProject()
      const firstTurn = get().messages.length === 0
      // 敲下回车这一刻消息就上屏，不等服务端：起轮要过网络，空着几秒像没反应。
      pendingSeq += 1
      // 旧跟随者被重置后发不出它收尾的「已接上」，这里不清，新轮一开场就挂着重连提示。
      set((state) => ({
        turn: 'running',
        stopping: false,
        reconnecting: false,
        error: null,
        activeTurn: null,
        messages: [
          ...state.messages.filter((one) => one.kind !== 'text' || !one.pending),
          {
            kind: 'text',
            id: `${PENDING_PREFIX}${pendingSeq}`,
            turnId: `${PENDING_PREFIX}${pendingSeq}`,
            role: 'user',
            text: trimmed,
            ...(references.length ? { references } : {}),
            streaming: false,
            pending: true,
          },
        ],
      }))
      // 标题这一刻就跟上：Agent 也会取名，但那是一轮跑完之后的事，中间几十秒顶栏挂着
      // 「未命名项目」，项目列表里连着几条也分不出谁是谁。用户自己改过名的不动。
      if (firstTurn && sourceProject && !sourceProject.customName) {
        const titled = firstMessageTitle(trimmed)
        if (titled && titled !== sourceProject.name)
          void useCanvasProjectStore
            .getState()
            .autoName(sourceProject.id, titled)
            .catch(() => {})
      }
      const turnDelivery = delivery.beginTurn()
      const submission = { cancelled: false, delivery: turnDelivery }
      pendingStart = submission
      const cancelUnsent = async () => {
        if (turnDelivery.isCurrent())
          set((state) => ({
            turn: 'idle',
            stopping: false,
            activeTurn: null,
            error: null,
            messages: state.messages.filter((one) => one.kind !== 'text' || !one.pending),
          }))
        await turnDelivery.settled()
        return 'cancelled' as const
      }
      try {
        let target = conversationId
        try {
          if (!target) {
            target = await createProjectConversation()
            if (submission.cancelled) return await cancelUnsent()
            if (!turnDelivery.isCurrent()) {
              await turnDelivery.settled()
              return
            }
            if (!(await bindNewCanvasWorkspace(target))) {
              if (turnDelivery.isCurrent())
                fail(i18next.t('error.canvasBindFailed', { ns: 'agent' }))
              await turnDelivery.settled()
              return
            }
            if (!turnDelivery.isCurrent()) {
              await turnDelivery.settled()
              return
            }
            safeLocalStorage.setItem(conversationKey(), target)
            bindNewAgentDraft(target, currentCanvasProject()?.id)
            set({ conversationId: target })
            if (sourceProject?.cloud && cloudProjectsEnabled()) {
              let history: Awaited<ReturnType<typeof fetchMessages>>
              try {
                history = await fetchMessages(target)
              } catch (error) {
                if (turnDelivery.isCurrent()) set({ historyFailed: true })
                throw error
              }
              if (!turnDelivery.isCurrent()) return
              const restored = panelStateFromHistory(history)
              set((state) => ({
                turns: restored.turns,
                messages: [
                  ...restored.messages,
                  ...state.messages.filter((one) => one.kind === 'text' && one.pending),
                ],
              }))
              if (history.activeTurn) {
                await openConversation(target, history.activeTurn.turnId)
                return
              }
            }
          }
        } catch {
          if (turnDelivery.isCurrent()) fail()
          await turnDelivery.settled()
          return
        }
        if (submission.cancelled) return await cancelUnsent()
        const turnParams = currentTurnParams()
        // 起轮这一步的失败不在 `follow` 的重连范围里：请求没发出去就没有轮可以接。
        let outcome: StartTurnOutcome
        try {
          outcome = await startTurn(
            target,
            trimmed,
            references,
            turnParams,
            mode,
            undefined,
            undefined,
            clarificationAnswer,
          )
        } catch (thrown) {
          if (turnDelivery.isCurrent())
            fail(
              thrown instanceof AgentRequestError && thrown.status === 429
                ? TURN_RATE_LIMITED()
                : thrown instanceof AgentRequestError && thrown.code === 'invalid_selection'
                  ? i18next.t('error.invalidSelection', { ns: 'agent' })
                  : thrown instanceof AgentRequestError && thrown.code === 'invalid_reference'
                    ? i18next.t('error.invalidReference', { ns: 'agent' })
                    : undefined,
            )
          await turnDelivery.settled()
          return
        }
        if (outcome.kind === 'frames' && sourceProject)
          void useCanvasProjectStore
            .getState()
            .update(sourceProject.id, { hasContent: true, updatedAt: Date.now() })
            .catch(() => {})
        const refused = outcome.kind === 'queued' && outcome.body.state === 'cancelled'
        if (!turnDelivery.isCurrent()) {
          if (outcome.kind === 'queued' && !refused) onAccepted?.()
          if (outcome.kind === 'frames') {
            onAccepted?.()
            await follow(
              target,
              { frames: outcome.frames },
              trimmed,
              turnDelivery,
              async (turnId) => {
                if (submission.cancelled) await requestAbort(target, turnId)
              },
            )
          } else await turnDelivery.settled()
          return
        }
        if (refused) {
          // 服务端说这句话已不在队里：没被收下，草稿留着，与起轮请求失败同样收场。
          fail(i18next.t('error.queueFailed', { ns: 'agent' }))
          await turnDelivery.settled()
          return
        }
        if (outcome.kind === 'queued') {
          // 别的标签页或设备正占着这个会话：这句话排进了队，挂到在跑的那一轮上去。
          onAccepted?.()
          await turnDelivery.settled()
          set({ stopping: false })
          await openConversation(target, outcome.body.turnId)
          return
        }
        if (outcome.kind === 'alreadyRunning') {
          // 别的标签页已经在这个会话里跑轮了。它那条用户消息只在服务端，先把历史读回来再续播。
          await turnDelivery.settled()
          set({ stopping: false })
          await openConversation(target, outcome.turnId)
          if (get().conversationId === target)
            set({ error: i18next.t('error.turnAlreadyRunning', { ns: 'agent' }) })
          return
        }
        onAccepted?.()
        await follow(target, { frames: outcome.frames }, trimmed, turnDelivery, async (turnId) => {
          if (submission.cancelled) await requestAbort(target, turnId)
        })
        if (firstTurn) {
          await get().refreshConversations()
          setTimeout(() => void get().refreshConversations(), titleRewriteMs)
        }
      } finally {
        if (pendingStart === submission) pendingStart = null
      }
    },

    async abort() {
      if (get().turn !== 'running' || get().stopping) return
      const active = get().activeTurn
      const conversationId = get().conversationId
      if (!active || !conversationId) {
        if (pendingStart?.delivery.isCurrent()) {
          pendingStart.cancelled = true
          set({ stopping: true, error: null })
        }
        return
      }
      set({ stopping: true, error: null })
      await requestAbort(conversationId, active.turnId)
    },

    async withdrawQueued(queueId) {
      const conversationId = get().conversationId
      if (!conversationId) return
      const current = () => get().conversationId === conversationId
      try {
        const result = await withdrawQueuedMessage(conversationId, queueId)
        if (!current()) return
        // 三种结局都意味着它不再排着：撤回了、被处理了、或者本来就没有。
        set((state) => ({
          queue: removeQueuedMessage(state.queue, queueId),
          error:
            result === 'already_consumed'
              ? i18next.t('error.queueAlreadyConsumed', { ns: 'agent' })
              : null,
        }))
      } catch {
        if (current()) set({ error: i18next.t('error.queueWithdrawFailed', { ns: 'agent' }) })
      }
    },

    async interjectQueued(queueId) {
      const conversationId = get().conversationId
      if (!conversationId) return
      const current = () => get().conversationId === conversationId
      try {
        const result = await interjectQueuedMessage(conversationId, queueId)
        if (!current()) return
        // 那一轮刚好收尾：它照旧排着，下一轮处理。
        if (result === 'not_running') {
          set({ error: i18next.t('error.queueInterjectTooLate', { ns: 'agent' }) })
          return
        }
        // 其余结局都意味着它不再排着：插进去了、被处理了、撤回了或者本来就没有。
        set((state) => ({
          queue: removeQueuedMessage(state.queue, queueId),
          error:
            result === 'already_consumed'
              ? i18next.t('error.queueInterjectConsumed', { ns: 'agent' })
              : null,
        }))
      } catch {
        if (current()) set({ error: i18next.t('error.queueInterjectFailed', { ns: 'agent' }) })
      }
    },

    async placeOnCanvas(messageId) {
      const message = get().messages.find((one) => one.id === messageId)
      if (message?.kind !== 'tool') return
      if (message.status === 'succeeded' && deliverable(message))
        await delivery.placeOnCanvas(message)
    },

    async cancelJob(messageId) {
      const { conversationId, messages } = get()
      const message = messages.find((one) => one.id === messageId)
      if (!conversationId || message?.kind !== 'tool' || !unsettled(message)) return
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
        if (get().conversationId !== conversationId) return
        for (const one of jobs) settleJob(one, conversationId)
        return
      }
      if (!message.job) return
      const job = await requestJobCancel(conversationId, message.job.taskId)
      if (get().conversationId !== conversationId) return
      settleJob(job, conversationId)
    },

    async retry(messageId, placeholderId, generationId) {
      const conversationId = get().conversationId
      if (!conversationId) return false
      let view: Awaited<ReturnType<typeof retryToolCall>>
      try {
        view = await retryToolCall(conversationId, messageId, placeholderId)
      } catch (thrown) {
        if (get().conversationId !== conversationId) return false
        // 没提交成：按拒绝的码给出路（去充值、去登录、让助手重新处理），不读服务端文字。
        const code = thrown instanceof AgentRequestError ? thrown.toolErrorCode : undefined
        if (code && placeholderId) {
          // 本机占位写进占位本身；云端占位由画布跳过，出路靠盖在上面的这一层。
          agentCanvasSink()?.markFailed([placeholderId], '', code)
          const refusal: AgentRetryRefusal = generationId ? { code, generationId } : { code }
          set((state) => ({ retryRefusals: { ...state.retryRefusals, [placeholderId]: refusal } }))
        }
        set({
          error: agentToolFailureText(code) ?? i18next.t('error.retryFailed', { ns: 'agent' }),
        })
        return false
      }
      if (get().conversationId !== conversationId) return true
      const card = panelMessage(view.id, view.turnId, view.role, view.content)
      if (card.kind !== 'tool') return true
      // 同一个占位上已有一次重试时，服务端原样给回那一条：这台设备已经在等它就不再开第二个把手。
      const shown = get().messages.some((message) => message.id === card.id)
      set((state) => {
        const { [placeholderId ?? '']: _cleared, ...retryRefusals } = state.retryRefusals
        return {
          error: null,
          retryRefusals,
          messages: shown ? state.messages : [...state.messages, card],
        }
      })
      if (shown) {
        if (card.status === 'submitted' && placeholderId)
          await agentCanvasSink()?.revive?.([placeholderId])
        return true
      }
      if (card.status === 'queued') {
        // 排在别的重试后面：还没提交、没扣费，占位保持失败并标着排队中，轮到时再转圈。
        watchJobs(conversationId)
        return true
      }
      // 重试有自己的消耗：预扣已经发生，顶栏余额跟着刷新。
      notifyPrivateSubmissionSettled()
      if (placeholderId) await agentCanvasSink()?.revive?.([placeholderId])
      if (get().conversationId !== conversationId) return true
      if (card.status !== 'submitted') {
        // 给回的那一条已经结束（别的设备点的重试已经补上）：照后台任务的终局落一次。
        deliverJob(card)
        return true
      }
      const handle = delivery.beginTurn()
      if (placeholderId) handle.adopt(card.id, [placeholderId])
      jobDeliveries.set(card.id, handle)
      watchJobs(conversationId)
      return true
    },

    async retryRemaining(messageId) {
      const origin = get().messages.find((message) => message.id === messageId)
      if (origin?.kind !== 'tool') return
      const remaining = agentRetryRemaining(
        get().messages,
        origin,
        agentCanvasSink()?.failedPlaceholders?.({
          messageId,
          taskIds: agentRetrySlotTasks(get().messages, origin),
        }) ?? [],
        get().retryRefusals,
      )
      // 按占位的先后逐个点：第一条当场提交，其余在服务端排队。被拒（积分不够等）就停下，
      // 不刷出一串同样的错。
      for (const placeholder of remaining) {
        const accepted = await get().retry(
          messageId,
          placeholder.id,
          ...(placeholder.generationId ? [placeholder.generationId] : []),
        )
        if (!accepted) return
      }
    },

    setPromptDraft(messageId, prompt) {
      set((state) => ({ promptDrafts: { ...state.promptDrafts, [messageId]: prompt } }))
    },

    async confirmPrompt(messageId, prompt) {
      const conversationId = get().conversationId
      const draft = get().messages.find((one) => one.id === messageId)
      const text = prompt.trim()
      // 空提示词提交不了；界面按住了按钮，这里守住第二道。
      if (!conversationId || draft?.kind !== 'tool' || !text) return { ok: false, reason: 'failed' }
      let view: AgentMessageView
      try {
        view = await confirmToolPrompt(conversationId, messageId, text)
      } catch (thrown) {
        if (!(thrown instanceof AgentRequestError)) return { ok: false, reason: 'failed' }
        if (thrown.status === 404) return { ok: false, reason: 'gone' }
        if (thrown.status === 422) return { ok: false, reason: 'notConfirmable' }
        // 服务端拒了这次提交：按码给出路（去充值、去登录、让助手换个做法），不读服务端文字。
        return thrown.toolErrorCode
          ? { ok: false, reason: 'refused', code: thrown.toolErrorCode }
          : { ok: false, reason: 'failed' }
      }
      // 生成任务的预扣在服务端已经发生（拟稿不扣），顶栏余额属于用户而不属于某个项目：
      // 即使这会儿已经切走，也要刷新，否则余额与提交门禁一直停在确认之前那一份。
      notifyPrivateSubmissionSettled()
      // 卡与画布归那个会话：切走之后不再动它们，回到这个项目时由读回的历史接手。
      if (get().conversationId !== conversationId) return { ok: true }
      const card = panelMessage(view.id, view.turnId, view.role, view.content)
      if (card.kind !== 'tool') return { ok: true }
      const shown = get().messages.find((one) => one.id === card.id)
      // 两次确认的响应乱序回来：终局那一份已经落过画布，慢一步的「已提交」不能把它拉回去，
      // 更不能再占一次位——那些位没有人会来认领，只会在画布上一直转圈。
      if (
        shown?.kind === 'tool' &&
        unsettled(card) &&
        (shown.status === 'succeeded' || shown.status === 'failed')
      )
        return { ok: true }
      // 服务端就地改写同一条消息：草稿卡原地换成提交之后的样子，不会多出一张。
      set((state) => {
        const { [messageId]: _confirmed, ...promptDrafts } = state.promptDrafts
        return {
          error: null,
          promptDrafts,
          messages: state.messages.map((one) => (one.id === card.id ? card : one)),
        }
      })
      if (unsettled(card)) {
        // 双击、多标签页重复确认：这台设备已经在等它，不再占第二次位。
        if (jobDeliveries.has(card.id)) return { ok: true }
        // 拟稿那一步没有占位（`toolStart` 不带张数），位要在这里占：画布随即转圈，产物落进这些位。
        const handle = delivery.beginTurn()
        handle.reserve(card.id, agentDraftReservation(card, conversationId))
        jobDeliveries.set(card.id, handle)
        watchJobs(conversationId)
        return { ok: true }
      }
      // 回来的已经是终局（重复确认时那个任务已经跑完）：交给交付收场，它认领这次调用占的位。
      // 轮询只认没结束的卡，这一步不做就没有第二次机会，占的位会一直转圈。
      deliverJob(card)
      return { ok: true }
    },

    async confirmAllPrompts() {
      // 先把这一刻的清单定死：确认会就地换掉卡片，边遍历边读 messages 会漏掉后面那些。
      const pending = get().messages.flatMap((one) =>
        one.kind === 'tool' && one.status === 'awaiting_confirmation'
          ? [{ id: one.id, prompt: get().promptDrafts[one.id] ?? one.prompt ?? '' }]
          : [],
      )
      let confirmed = 0
      for (const card of pending) {
        const result = await get().confirmPrompt(card.id, card.prompt)
        if (!result.ok) return { confirmed, failure: result }
        confirmed += 1
      }
      return { confirmed, failure: null }
    },
  }
})

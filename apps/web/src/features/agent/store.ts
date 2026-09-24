import type {
  AgentActiveTurnView,
  AgentBackgroundJobProgress,
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
  AGENT_TURN_MAX_INLINE_REFERENCES,
  PROJECT_NAME_MAX_LENGTH,
} from '@image-playground/shared'
import { create } from 'zustand'
import { requireAccount } from '../../auth/loginPrompt'
import { i18next } from '../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../lib/apiProfiles'
import {
  AGENT_CONVERSATION_KEY,
  accountScope,
  safeLocalStorage,
  scopedStorageName,
} from '../../lib/authScope'
import { isClientCapabilityEnabled } from '../../lib/clientCapabilities'
import { notifyPrivateSubmissionSettled } from '../../lib/privateOverlay'
import { useStore } from '../../store'
import {
  autoNameProject,
  bindNewCanvasWorkspace,
  conversationSceneKey,
  currentCanvasWorkspace,
  importConversationProjects,
  openCanvasCloudSession,
  openProject,
  selectCanvasWorkspace,
} from '../canvas/lib/activeProject'
import { cloudProjectsEnabled, getCloudProject } from '../canvas/lib/projectClient'
import type { CanvasProject } from '../canvas/lib/projectRepository'
import { canvasSceneKey } from '../canvas/lib/workspaceKeys'
import {
  currentCanvasProject,
  restoreCloudProject,
  useCanvasProjectStore,
} from '../canvas/projectStore'
import { clampPanelWidth, PANEL_WIDTH } from './agentStyles'
import {
  type AgentConversationState,
  AgentRequestError,
  type AgentTurnSource,
  abortTurn,
  confirmToolPrompt,
  fetchConversations,
  fetchMessages,
  followTurn,
  inlineReferenceCount,
  interjectQueuedMessage,
  interjectTurn,
  removeConversation,
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
import { type AgentJobSession, createAgentBackgroundJobs } from './lib/backgroundJobs'
import { agentCanvasSink, onAgentCanvasSinkChange } from './lib/canvasSink'
import { bindNewAgentDraft } from './lib/drafts'
import { agentJobUnsettled } from './lib/jobProgress'
import {
  addQueuedMessage,
  hasWaitingMessages,
  reduceMessageQueue,
  removeQueuedMessage,
  returnQueuedToDraft,
} from './lib/messageQueue'
import {
  bindOutgoingConversation,
  forgetOutgoing,
  type OutgoingMessage,
  outgoingMessages,
  rememberOutgoing,
} from './lib/outgoingJournal'
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
import { type AgentRetryRefusal, agentRetryRemaining, agentRetrySlotTasks } from './lib/retry'
import { agentToolFailureText, promptAgentRecharge } from './lib/toolFailure'
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
    /**
     * 这条消息的客户端 id。刷新后重发本机存着的那条时带上原来的那个：服务端按它认出是
     * 同一条，不会排第二次，也不会重复扣费。缺席即新生成一个。
     */
    clientMessageId?: string,
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

/**
 * 画布上的图换成云端媒体引用（`aip-media:`），`agentClient` 发送时就只带 id。
 *
 * 本机画布存的是原图 data URL——用户传的图、智能体产物落画布时都是整张原图——上传之后 id 只在
 * 同步会话的绑定表里。不换的话一轮十张主图就是几十 MB 的请求体，慢，然后失败。
 * 画过遮罩、烧过批注的那张是新像素，云端没有它，照旧内联；认不出的（没开云项目、同步失败）也照旧。
 */
async function withCloudMedia(
  references: readonly AgentTurnReference[],
): Promise<readonly AgentTurnReference[]> {
  const cloud = openCanvasCloudSession()
  const local = references.flatMap((one) =>
    'dataUrl' in one && !one.maskDataUrl && one.dataUrl.startsWith('data:image/')
      ? [one.dataUrl]
      : [],
  )
  if (!cloud || local.length === 0) return references
  const ids = await cloud.mediaIdsFor(local)
  return references.map((one) => {
    const id = 'dataUrl' in one && !one.maskDataUrl ? ids.get(one.dataUrl) : undefined
    return id ? { ...one, dataUrl: `aip-media:${id}` } : one
  })
}

/**
 * 这一份参考图能不能发出去。上传没成、离线、同步被打回时，圈中的图换不成 id，就只剩内联
 * 这一条路；服务端对内联张数有硬上限，超了必被 4xx 打回。照发的代价不是一次失败，而是
 * 先把几十 MB 传上几分钟：那几分钟里面板一直挂着「发送中」，最后才说失败。所以发之前就拦。
 */
const REFERENCES_NOT_UPLOADED = () => i18next.t('error.referencesNotUploaded', { ns: 'agent' })

const sendableReferences = (references: readonly AgentTurnReference[]) =>
  inlineReferenceCount(references) <= AGENT_TURN_MAX_INLINE_REFERENCES
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

/** 上一轮收尾后找服务端接着开的那一轮：最多看这么多次，每次隔这么久。 */
const QUEUE_PICKUP_ATTEMPTS = 8
const QUEUE_PICKUP_DELAY_MS = 250
/** 停止请求没拿到响应时，连同第一次一共发这么多次。 */
const STOP_ATTEMPTS = 3
/**
 * 停止已经答应下来、轮的终帧还没到时，紧接着发出的那一句最多等这么久。等到了就起新的一轮，
 * 等不到就按当时的状态走（挂成排队消息，服务端收尾后照样处理），不把用户卡在这里。
 */
const ABORT_SETTLE_GRACE_MS = 2_000

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
 * 挂上快照里那一轮：快照先行、增量接在它的游标之后。游标只对快照里那一轮成立——409 兜底给的
 * 轮可能已经跑完，它在游标之前，只能按轮从头重放。
 */
const turnSource = (taken: AgentConversationState, turnId: string): AgentTurnSource =>
  taken.activeTurn?.turnId === turnId && taken.cursor !== undefined
    ? { turnId, cursor: taken.cursor }
    : { turnId }

/**
 * 换会话时要清掉的一切：属于上一个会话的消息、页脚、排队、草稿卡上改过的字、任务进度、
 * 工具起跑时刻、重试被拒盖在占位上的那一层，连同断线提示与上一次的报错。
 * 返回的是一份补丁，调用方一次 `set` 下去：任何一次渲染都不能看见「消息已清、会话还是旧的」。
 */
const sessionReset = (conversationId: string | null): Partial<AgentState> => ({
  conversationId,
  messages: [],
  turns: {},
  queue: [],
  promptDrafts: {},
  jobProgress: {},
  toolStartedAt: {},
  retryRefusals: {},
  turn: 'idle',
  stopping: false,
  reconnecting: false,
  activeTurn: null,
  error: null,
  historyLoading: false,
  historyFailed: false,
})

function readPanelWidth(): number {
  const raw = Number(safeLocalStorage.getItem(PANEL_WIDTH_KEY))
  return Number.isFinite(raw) && raw > 0 ? clampPanelWidth(raw) : PANEL_WIDTH
}

export const useAgentStore = create<AgentState>((set, get, store) => {
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

  /** 后台任务经这几个口子读写面板；别的都在 `lib/backgroundJobs` 里面。 */
  const jobSession: AgentJobSession = {
    messages: () => get().messages,
    isCurrent: (conversationId) => get().conversationId === conversationId,
    isIdle: (conversationId) => get().conversationId === conversationId && get().turn !== 'running',
    replaceCard: (card) =>
      set((state) => ({
        messages: state.messages.map((message) => (message.id === card.id ? card : message)),
      })),
    appendCards: (cards) => set((state) => ({ messages: [...state.messages, ...cards] })),
    reportProgress: (messageId, progress) =>
      set((state) => ({ jobProgress: { ...state.jobProgress, [messageId]: progress } })),
    coverRefusal: (placeholderId, refusal) =>
      set((state) => ({ retryRefusals: { ...state.retryRefusals, [placeholderId]: refusal } })),
    adopt: async (conversationId, taken, options) => {
      if (options?.join) {
        await joinQueuedTurn(conversationId, taken, options.join)
        return
      }
      adoptSnapshot(conversationId, taken)
    },
  }
  const jobs = createAgentBackgroundJobs({ delivery, session: jobSession })

  /**
   * 交付换代（切会话、新建会话、停止撞上 404 后按历史重来）：移交给后台任务的把手全部作废，
   * 本轮的交付也换一代。之后再结算的任务按当时的画布现开把手，不会拿着旧一代的来源落成
   * 「画布已离开」。
   */
  const resetDelivery = () => {
    jobs.reset()
    return delivery.reset()
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
      if (card.kind !== 'tool') turnDelivery.discard(event.messageId)
      // 后台任务：占的位不随这一轮收掉，交给任务，等它结束再落。
      else if (event.status === 'submitted')
        jobs.track(conversationId, card, { kind: 'handOff', turn: turnDelivery })
      else if (event.status === 'failed') {
        turnDelivery.failed(event.messageId, event.message, card.errorCode)
        promptAgentRecharge(card.errorCode)
      } else if (deliverable(card)) turnDelivery.enqueue(card)
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
      let snapshot: AgentConversationState
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
   * 换上这份快照，面板与后台任务一起接管。
   *
   * 已经确认提交的那次生成只往前走（`reconcileToolCard`）：慢一步的历史里它还是草稿，盖回去
   * 就再没人等这个后台任务；交付状态是本机的，跟着面板上那张走。排队列表以快照为准。
   * 快照里已经结算的后台任务当场交付，还没结束的接着等——轮询只认没结束的卡，这一步不做，
   * 交出去的占位会一直转圈。
   *
   * `join` 是要挂上的那一轮；`keepPending` 留住本机那条还没上轮的用户气泡（新建会话读云端
   * 历史时用），其余情况下服务端那份就是全部。
   */
  const adoptSnapshot = (
    conversationId: string,
    taken: AgentConversationState,
    options: { readonly join?: string; readonly keepPending?: boolean } = {},
  ) => {
    const shown = new Map(get().messages.map((message) => [message.id, message]))
    const history = panelStateFromHistory(taken)
    const pending = options.keepPending
      ? get().messages.filter((message) => message.kind === 'text' && message.pending)
      : []
    set({
      ...history,
      messages: [
        ...history.messages.map((message) => reconcileToolCard(shown.get(message.id), message)),
        ...pending,
      ],
      queue: [...(taken.queue ?? [])],
      ...(options.join
        ? {
            turn: 'running' as const,
            stopping: false,
            reconnecting: false,
            error: null,
            activeTurn: { turnId: options.join },
          }
        : {}),
    })
    void delivery.restore(get().messages)
    jobs.resume(conversationId, get().messages)
  }

  /**
   * 挂上服务端从队里接着开的那一轮。同一个会话不走 `openConversation`：它会重置交付，把上一轮
   * 交给后台任务的占位一起收掉。
   */
  const joinQueuedTurn = async (
    conversationId: string,
    taken: AgentConversationState,
    turnId: string,
  ) => {
    adoptSnapshot(conversationId, taken, { join: turnId })
    await follow(conversationId, turnSource(taken, turnId), null, delivery.beginTurn())
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
      // 换会话：草稿卡上改过的字、任务进度这些都跟着那个会话走，不带进新的。
      ...(same ? { conversationId } : sessionReset(conversationId)),
      error: null,
      turn: 'idle',
      stopping: false,
      reconnecting: false,
      activeTurn: null,
      historyLoading: true,
      historyFailed: false,
    })
    selectCanvasWorkspace(conversationSceneKey(conversationId))
    let state: AgentConversationState
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
          openProject(project.id)
          set({ ...sessionReset(null), error: CONVERSATION_GONE() })
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
    set({ historyLoading: false, historyFailed: false })
    adoptSnapshot(conversationId, state)
    const active = state.activeTurn?.turnId ?? turnId
    if (!active) {
      // 历史读回来了、也没有在跑的轮：发送途中丢掉的那几条现在补发。
      const project = currentCanvasProject()
      if (project?.conversationId === conversationId) void resumeOutgoing(project.id)
      return
    }
    set({ turn: 'running', error: null, activeTurn: { turnId: active } })
    await follow(conversationId, turnSource(state, active), null, delivery.beginTurn())
  }

  /**
   * 服务端历史里已经有这一句了。文本与带图张数都对得上就算同一条：本机那份是交出去
   * 之后、确认之前留下的备份，服务端收下了就不必再留。
   */
  const deliveredAlready = (message: OutgoingMessage) =>
    get().messages.some(
      (one) =>
        one.kind === 'text' &&
        one.role === 'user' &&
        !one.pending &&
        one.text === message.text &&
        (one.references?.length ?? 0) === message.references.length,
    )

  const resuming = new Set<string>()
  /**
   * 交出去却没等到服务端应答的那几条（发送途中刷新、断网）：本机存着，回来时原样重发。
   * 带的是原来那个 `clientMessageId`，服务端按它认出是同一条——真收下过就不会排第二次。
   */
  const resumeOutgoing = async (projectId: string) => {
    if (resuming.has(projectId)) return
    resuming.add(projectId)
    try {
      for (const message of await outgoingMessages(projectId)) {
        // 项目换了就停：这几条属于刚才那个项目，发到别处去就串了。
        if (currentCanvasProject()?.id !== projectId) return
        if (deliveredAlready(message)) {
          await forgetOutgoing(projectId, message.id)
          continue
        }
        // 这个会话正跑着一轮：跑的可能就是它。等这一轮收尾后的下一次打开再说，
        // 本机这份留着，丢不了。
        if (get().turn === 'running') return
        await get().send(message.text, message.references, undefined, message.mode, message.id)
      }
    } finally {
      resuming.delete(projectId)
    }
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
  let pendingStart: {
    cancelled: boolean
    delivery: TurnArtifactDelivery
    settled: Promise<void>
  } | null = null
  /** 还没落定的那次中止。界面已经放行，新的一轮在起轮前静默等它，不把话挂到正在停的轮上。 */
  let abortInFlight: Promise<unknown> | null = null
  /**
   * 服务端答应了停，轮的终帧还在流上飞：等它落地（有上限），紧接着发出的那一句才起成新的一轮，
   * 而不是被挂成正在停的这一轮的排队消息。等不到就按现状走，不把用户卡在这里。
   */
  const turnSettledAfterAbort = (conversationId: string) =>
    new Promise<void>((resolve) => {
      const now = get()
      if (now.conversationId !== conversationId || now.turn !== 'running' || !now.stopping) {
        resolve()
        return
      }
      const finish = () => {
        clearTimeout(timer)
        unsubscribe()
        resolve()
      }
      const timer = setTimeout(finish, ABORT_SETTLE_GRACE_MS)
      const unsubscribe = store.subscribe((next) => {
        if (next.conversationId !== conversationId || next.turn !== 'running' || !next.stopping)
          finish()
      })
    })
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
            })
            adoptSnapshot(conversationId, history)
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
    clientMessageId: string,
  ) => {
    const current = () => get().conversationId === conversationId
    try {
      const sent = await withCloudMedia(references)
      if (!sendableReferences(sent)) {
        if (current()) set({ error: REFERENCES_NOT_UPLOADED() })
        return
      }
      const outcome = await startTurn(
        conversationId,
        text,
        sent,
        currentTurnParams(),
        mode,
        undefined,
        clientMessageId,
        clarificationAnswer,
      )
      if (outcome.kind === 'queued' && outcome.body.state === 'cancelled') {
        // 服务端说它已不在队里（没能开轮被退回、或被别的设备撤回）：这句话没有被收下，草稿留着。
        if (current()) set({ error: i18next.t('error.queueFailed', { ns: 'agent' }) })
        return
      }
      if (outcome.kind === 'alreadyRunning') {
        // 老服务端没有排队：忙时照旧是插话。
        await interjectTurn(conversationId, active?.turnId ?? outcome.turnId, text, sent)
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

  /**
   * 当前会话正跑着一轮。ADR-0005 决策「运行中禁止切换、新建或删除当前会话」在这一处成文：
   * 换走它、删掉它都要等这一轮结束。规则只管「轮」——生成早已是后台任务（ADR-0012），
   * 产物按项目交付，画布上还没落回来的那些由 `prepareCanvasRemoval` 单独拦。
   */
  const currentTurnRunning = () => get().turn === 'running'

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
    reset: (project) => {
      set({
        ...sessionReset(project.conversationId),
        loaded: true,
        tab: 'chat',
        open: true,
      })
      // 会话都还没建起来就断在半路的那几条：这里没有历史要等，直接补发。
      if (!project.conversationId) void resumeOutgoing(project.id)
    },
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

  /**
   * 项目已经在屏幕上了，再去把云端那份对一遍。
   *
   * 名字与 revision 换上去就行，画布不归这里管（它自己回源）。只有一种情况要重开面板：
   * 别的设备给这个项目换过会话绑定——那时本机开着的是一段已经不属于它的历史。
   * 取不回来不算失败：画布与草稿都在本机，用户照常能用，一句提示足够。
   */
  const refreshOpenedProject = async (
    project: CanvasProject,
    sameAccount: () => boolean,
    isCurrent: () => boolean,
  ) => {
    if (!project.cloud?.revision || !cloudProjectsEnabled() || navigator.onLine === false) return
    const settled = () =>
      isCurrent() && sameAccount() && useCanvasProjectStore.getState().activeId === project.id
    try {
      const remote = await getCloudProject(project.id, AbortSignal.timeout(10000))
      if (!settled()) return
      const refreshed = await restoreCloudProject(remote)
      if (!settled()) return
      useCanvasProjectStore.getState().updateListed(refreshed)
      if (refreshed.conversationId !== project.conversationId) showProject(refreshed, showPanel)
    } catch {
      if (settled())
        useStore.getState().showToast(i18next.t('project.openFailed', { ns: 'agent' }), 'error')
    }
  }
  /** 删除时属于面板的那两步，外加它此刻的两件事实。 */
  const deletePanel: DeleteProjectPanel = {
    get conversationId() {
      return get().conversationId
    },
    get running() {
      return currentTurnRunning()
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
      // 还没有会话的项目不会走 `openConversation`，补发的入口在这里。
      const project = currentCanvasProject()
      if (project && !project.conversationId) await resumeOutgoing(project.id)
    },

    async refreshConversations() {
      const revision = conversationListRevision
      try {
        const conversations = await fetchConversations()
        if (changingProject || revision !== conversationListRevision) return
        set({ conversations })
        if (useCanvasProjectStore.getState().loaded)
          await importConversationProjects(
            conversations,
            () => !changingProject && revision === conversationListRevision,
          )
      } catch {
        // 列表读不回来不该拖垮面板，留着上一份。
      }
    },

    async selectConversation(conversationId) {
      if (currentTurnRunning()) return
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
      if (currentTurnRunning() && get().conversationId === conversationId) return
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
      selectCanvasWorkspace(canvasSceneKey(null))
      safeLocalStorage.removeItem(conversationKey())
      set(sessionReset(null))
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
        const sameAccount = accountScope()
        const project = useCanvasProjectStore
          .getState()
          .projects.find((one) => one.id === projectId)
        if (!project) return false
        if (!(await saveCurrentProject(get().conversationId)).ok) {
          useStore.getState().showToast(i18next.t('project.saveFailed', { ns: 'agent' }), 'error')
          return false
        }
        if (!isCurrent()) return false
        try {
          await useCanvasProjectStore.getState().update(project.id, { workspaceOpened: true })
        } catch {
          useStore.getState().showToast(i18next.t('project.openFailed', { ns: 'agent' }), 'error')
          return false
        }
        if (!isCurrent()) return false
        // 本机这份就足够开：画布自己回源（`openProject` 选中时的 `refreshCloud`），
        // 会话历史另有一条请求，面板有它自己的加载态。云端那份只用来纠正名字、revision
        // 与会话绑定——生产实测它要 1.5s，压在点击与画面之间就是纯粹的干等，
        // 所以放到后台，顺带让离线时也能打开项目。
        showProject(project, showPanel)
        void refreshOpenedProject(project, sameAccount, isCurrent)
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

    async send(text, references = [], onAccepted, mode = get().mode, clientMessageId) {
      // 停止是秒生效的界面动作，后台还在跟服务端交涉。这几百毫秒里用户又发了一句：不报错、
      // 不拦下，静默等中止落定再起新轮——否则这一句会被当成排队消息挂到正在停的那一轮上。
      if (get().stopping && abortInFlight) await abortInFlight
      if (changingProject || get().historyLoading || get().historyFailed) return
      const trimmed = text.trim()
      if (!trimmed) return
      // 计费部署的起轮要账号（BFF 在 `/api/agent/turns` 上直接 401）：先弹登录框，
      // 别把这句话上屏再被打回。没开积分计费的部署照旧按 deviceId 放匿名设备对话过。
      if (isClientCapabilityEnabled('billing:credits') && !requireAccount()) return

      const active = get().activeTurn
      const conversationId = get().conversationId
      // 末尾还有没作答的澄清：这句话就是在回答它（卡片与输入框同一个口径），服务端把它排在队首。
      const clarificationAnswer = answerableClarificationId(get().messages) !== null
      const sourceProject = currentCanvasProject()
      const messageId = clientMessageId ?? crypto.randomUUID()
      // 交出去之前先落本机，并且等它写完：这句话与服务端之间隔着几秒网络，刷新、断网都在
      // 这段里，只在内存里就等于没发过。写完才发，回来时照样看得到，也能拿同一个 id 重发。
      const journaled = sourceProject ? { projectId: sourceProject.id, id: messageId } : null
      if (journaled)
        await rememberOutgoing({
          id: messageId,
          projectId: journaled.projectId,
          conversationId,
          text: trimmed,
          references: [...references],
          mode,
          clarificationAnswer,
          createdAt: Date.now(),
        })
      const settleJournal = () => {
        if (journaled) void forgetOutgoing(journaled.projectId, journaled.id)
      }
      if (get().turn === 'running' && conversationId) {
        try {
          await queueMessage(
            conversationId,
            active,
            trimmed,
            references,
            onAccepted,
            mode,
            clarificationAnswer,
            messageId,
          )
        } finally {
          settleJournal()
        }
        return
      }
      if (get().turn === 'running') {
        settleJournal()
        return
      }

      // 首轮才会定标题、才会有新会话进列表；之后每轮再拉一次是白拉。
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
          void autoNameProject(sourceProject.id, titled).catch(() => {})
      }
      const turnDelivery = delivery.beginTurn()
      let settleSubmission = () => {}
      const submitted = new Promise<void>((resolve) => {
        settleSubmission = resolve
      })
      const submission = { cancelled: false, delivery: turnDelivery, settled: submitted }
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
            // 会话是刚刚建出来的：本机那份补上它，重发时才知道发去哪个会话。
            if (journaled) await bindOutgoingConversation(journaled.projectId, journaled.id, target)
            if (sourceProject?.cloud && cloudProjectsEnabled()) {
              let history: AgentConversationState
              try {
                history = await fetchMessages(target)
              } catch (error) {
                if (turnDelivery.isCurrent()) set({ historyFailed: true })
                throw error
              }
              if (!turnDelivery.isCurrent()) return
              // 云端项目原来那段历史先摆上，敲下回车那条先上屏的消息留在末尾等这一轮。
              adoptSnapshot(target, history, { keepPending: true })
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
        const sent = await withCloudMedia(references)
        if (!sendableReferences(sent)) {
          if (turnDelivery.isCurrent()) fail(REFERENCES_NOT_UPLOADED())
          await turnDelivery.settled()
          return
        }
        // 起轮这一步的失败不在 `follow` 的重连范围里：请求没发出去就没有轮可以接。
        let outcome: StartTurnOutcome
        try {
          outcome = await startTurn(
            target,
            trimmed,
            sent,
            turnParams,
            mode,
            undefined,
            messageId,
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
        settleJournal()
        settleSubmission()
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
          abortInFlight = pendingStart.settled
          set({ stopping: true, error: null })
        }
        return
      }
      set({ stopping: true, error: null })
      const settling = requestAbort(conversationId, active.turnId)
      // 界面已经放行；下一句要等的是「请求回来 + 终帧落地」，`abort()` 自己只等请求。
      const settled = settling.then(() => turnSettledAfterAbort(conversationId))
      abortInFlight = settled
      void settled.finally(() => {
        if (abortInFlight === settled) abortInFlight = null
      })
      await settling
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
      const conversationId = get().conversationId
      if (conversationId) await jobs.cancel(conversationId, messageId)
    },

    async retry(messageId, placeholderId, generationId) {
      const conversationId = get().conversationId
      if (!conversationId) return false
      let view: AgentMessageView
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
        jobs.track(conversationId, card, { kind: 'adopt', placeholderId })
        return true
      }
      // 重试有自己的消耗：预扣已经发生，顶栏余额跟着刷新。
      notifyPrivateSubmissionSettled()
      if (placeholderId) await agentCanvasSink()?.revive?.([placeholderId])
      if (get().conversationId !== conversationId) return true
      // 给回的那一条已经结束（别的设备点的重试已经补上）时，`track` 照后台任务的终局落一次。
      jobs.track(conversationId, card, { kind: 'adopt', placeholderId })
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
        agentJobUnsettled(card) &&
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
      jobs.track(conversationId, card, { kind: 'reserve' })
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

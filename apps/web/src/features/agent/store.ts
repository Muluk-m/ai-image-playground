import type {
  AgentActiveTurnView,
  AgentConversationView,
  AgentMode,
  AgentThinkingDepth,
  AgentTurnEvent,
  AgentTurnReference,
} from '@image-playground/shared'
import { AGENT_IMAGE_MAX_N } from '@image-playground/shared'
import { create } from 'zustand'
import { i18next } from '../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../lib/apiProfiles'
import { AGENT_CONVERSATION_KEY, safeLocalStorage, scopedStorageName } from '../../lib/authScope'
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
  fetchConversations,
  fetchMessages,
  followTurn,
  interjectTurn,
  removeConversation,
  type StartTurnOutcome,
  startTurn,
} from './lib/agentClient'
import { createArtifactDelivery, type TurnArtifactDelivery } from './lib/artifactDelivery'
import { onAgentCanvasSinkChange } from './lib/canvasSink'
import { bindNewAgentDraft } from './lib/drafts'
import {
  dropUnsettledMessages,
  panelMessage,
  panelStateFromHistory,
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
import { toAgentTurnParams } from './lib/turnParams'
import type { AgentPanelMessage, AgentPanelTab, AgentTurnFooter, AgentTurnStatus } from './types'

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

export interface AgentState {
  thinkingDepth: AgentThinkingDepth
  setThinkingDepth(depth: AgentThinkingDepth): void
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
  error: string | null
  loaded: boolean
  historyLoading: boolean
  historyFailed: boolean
  /** 对话面板宽度（CSS 像素），用户拖过就记住。 */
  panelWidth: number

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
  createProject(): Promise<boolean>
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
  /** 产物没能落下去（画布已离开等）时，由用户把那张结果卡的产出放进画布。 */
  placeOnCanvas(messageId: string): Promise<void>
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
    if (turnDelivery.isCurrent())
      set((state) => {
        const panel = reduceAgentPanelEvent(state, event, { turnId, pendingUserText })
        if (event.type === 'turnStart') return { ...panel, activeTurn: { turnId: event.turnId } }
        if (event.type !== 'turnEnd') return panel
        if (event.stopReason === 'failed') return { ...failPatch(state), turns: panel.turns }
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
      if (event.status === 'failed' && card.kind === 'tool')
        turnDelivery.failed(event.messageId, event.message, card.errorCode)
      else if (card.kind === 'tool' && card.artifacts?.length) turnDelivery.enqueue(card)
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
    try {
      for await (const event of stream.events) {
        if (event.type === 'turnStart') turnId = event.turnId
        apply(event, pendingUserText, turnId, turnDelivery, conversationId)
        if (event.type === 'turnStart') {
          await startedCallback?.(turnId)
          startedCallback = undefined
        }
      }
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
  }

  /**
   * 读回会话历史并挂上仍在跑的那一轮。切会话、以及起轮撞上别的标签页时走的都是这一条。
   * `turnId` 是起轮的 409 给出的兜底：历史里的 activeTurn 更新，但那一轮可能在这次读取之前
   * 刚好跑完——续播端点对已经结束的轮同样重放，用户照样看得到它的内容。
   */
  const openConversation = async (conversationId: string, turnId?: string) => {
    const isCurrent = delivery.reset()
    const same = get().conversationId === conversationId
    set({
      conversationId,
      ...(!same ? { messages: [], turns: {} } : {}),
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
    set({ historyLoading: false, historyFailed: false, ...panelStateFromHistory(state) })
    void delivery.restore(get().messages)
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

  // 发送请求尚未返回轮标识时，也必须记住用户的中止意图。
  let pendingStart: { cancelled: boolean; delivery: TurnArtifactDelivery } | null = null
  const requestAbort = async (conversationId: string, turnId: string) => {
    const current = () =>
      get().conversationId === conversationId && get().activeTurn?.turnId === turnId
    try {
      if (current()) set({ stopping: true, error: null })
      await abortTurn(conversationId, turnId)
    } catch (error) {
      if (!current()) return
      // 轮可能恰好结束；读回事实后再决定是否报错，不能把 404 当成中止成功。
      if (error instanceof AgentRequestError && error.status === 404) {
        try {
          const history = await fetchMessages(conversationId)
          if (!current()) return
          if (!history.activeTurn) {
            delivery.reset()
            set({
              turn: 'idle',
              stopping: false,
              activeTurn: null,
              error: null,
              ...panelStateFromHistory(history),
            })
            void delivery.restore(get().messages)
            return
          }
        } catch {
          /* 保留在运行的轮，让用户重试。 */
        }
      }
      if (current()) set({ stopping: false, error: i18next.t('error.stopFailed', { ns: 'agent' }) })
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
    resetDelivery: () => void delivery.reset(),
    reset: (project) =>
      set({
        conversationId: project.conversationId,
        messages: [],
        turns: {},
        turn: 'idle',
        stopping: false,
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
  const createProject = async (reuseEmpty = true) => {
    const saved = await saveCurrentProject(get().conversationId)
    if (!saved.ok) throw new Error(saved.reason)
    const current = currentCanvasProject()
    const { draft, unsent } = currentProjectDraft(get().conversationId).getSnapshot()
    // 重复点击不制造空壳；有引用、草稿、画布或正在提交的内容都必须新建。
    if (
      reuseEmpty &&
      current &&
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
    const project = await useCanvasProjectStore.getState().create()
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
    turn: 'idle',
    stopping: false,
    reconnecting: false,
    activeTurn: null,
    error: null,
    loaded: false,
    historyLoading: false,
    historyFailed: false,
    panelWidth: readPanelWidth(),
    mode: 'image',
    setMode: (mode) => {
      if (get().mode !== mode) set({ mode })
    },
    thinkingDepth: readThinkingDepth(),
    setThinkingDepth: (thinkingDepth) => {
      safeLocalStorage.setItem(THINKING_DEPTH_KEY, thinkingDepth)
      set({ thinkingDepth })
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
      delivery.reset()
      selectCanvasWorkspace(null)
      safeLocalStorage.removeItem(conversationKey())
      set({
        conversationId: null,
        messages: [],
        turns: {},
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

    async createProject() {
      return changeProject(async () => {
        try {
          return await createProject()
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

      const active = get().activeTurn
      const conversationId = get().conversationId
      if (get().turn === 'running' && active && conversationId) {
        try {
          await interjectTurn(conversationId, active.turnId, trimmed, references)
          onAccepted?.()
          if (get().conversationId === conversationId) set({ error: null })
        } catch (thrown) {
          if (get().conversationId === conversationId)
            set({
              error:
                thrown instanceof AgentRequestError && thrown.code === 'invalid_selection'
                  ? i18next.t('error.invalidSelection', { ns: 'agent' })
                  : i18next.t('error.interjectFailed', { ns: 'agent' }),
            })
        }
        return
      }
      if (get().turn === 'running') return

      // 首轮才会定标题、才会有新会话进列表；之后每轮再拉一次是白拉。
      const sourceProject = currentCanvasProject()
      const firstTurn = get().messages.length === 0
      // 敲下回车这一刻消息就上屏，不等服务端：起轮要过网络，空着几秒像没反应。
      pendingSeq += 1
      set((state) => ({
        turn: 'running',
        stopping: false,
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
            streaming: false,
            pending: true,
          },
        ],
      }))
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
        // 起轮这一刻的参数快照：轮跑到一半用户改了 chip，改的是下一轮，不该追改这一轮。
        const { params, settings } = useStore.getState()
        const model = clientProfileToApiProfile(getActiveApiProfile(settings)).model
        const turnParams = {
          ...toAgentTurnParams(params, model),
          thinkingDepth: get().thinkingDepth,
        }
        // 起轮这一步的失败不在 `follow` 的重连范围里：请求没发出去就没有轮可以接。
        let outcome: StartTurnOutcome
        try {
          outcome = await startTurn(target, trimmed, references, turnParams, mode)
        } catch (thrown) {
          if (turnDelivery.isCurrent())
            fail(
              thrown instanceof AgentRequestError && thrown.status === 429
                ? TURN_RATE_LIMITED()
                : thrown instanceof AgentRequestError && thrown.code === 'invalid_selection'
                  ? i18next.t('error.invalidSelection', { ns: 'agent' })
                  : undefined,
            )
          await turnDelivery.settled()
          return
        }
        if (outcome.kind !== 'alreadyRunning' && sourceProject)
          void useCanvasProjectStore
            .getState()
            .update(sourceProject.id, { hasContent: true, updatedAt: Date.now() })
            .catch(() => {})
        if (!turnDelivery.isCurrent()) {
          if (outcome.kind !== 'alreadyRunning') {
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
        if (firstTurn) await get().refreshConversations()
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

    async placeOnCanvas(messageId) {
      const message = get().messages.find((one) => one.id === messageId)
      if (message?.kind !== 'tool') return
      if (message.status === 'succeeded' && message.artifacts?.length)
        await delivery.placeOnCanvas(message)
    },
  }
})

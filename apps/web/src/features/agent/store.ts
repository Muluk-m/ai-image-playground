import type {
  AgentActiveTurnView,
  AgentClarificationBlock,
  AgentConversationView,
  AgentFrame,
  AgentMessageView,
  AgentToolResultBlock,
  AgentTurnEvent,
  AgentTurnReference,
} from '@image-playground/shared'
import { AGENT_IMAGE_MAX_N, agentMessageText } from '@image-playground/shared'
import { create } from 'zustand'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../lib/apiProfiles'
import { AGENT_CONVERSATION_KEY, safeLocalStorage, scopedStorageName } from '../../lib/authScope'
import { useStore } from '../../store'
import {
  bindNewCanvasWorkspace,
  canvasSceneKey,
  currentCanvasWorkspace,
  forgetCanvasWorkspace,
  prepareCanvasRemoval,
  selectCanvasWorkspace,
} from '../canvas/lib/workspaces'
import { currentCanvasProject, useCanvasProjectStore } from '../canvas/projectStore'
import { clampPanelWidth, PANEL_WIDTH } from './agentStyles'
import {
  AgentRequestError,
  abortTurn,
  createConversation,
  fetchConversations,
  fetchMessages,
  interjectTurn,
  removeConversation,
  resumeTurn,
  type StartTurnOutcome,
  startTurn,
} from './lib/agentClient'
import { createArtifactDelivery, type TurnArtifactDelivery } from './lib/artifactDelivery'
import { onAgentCanvasSinkChange } from './lib/canvasSink'
import { agentDraft, bindNewAgentDraft, removeProjectDraft } from './lib/drafts'
import { toAgentTurnParams } from './lib/turnParams'
import type {
  AgentClarificationMessage,
  AgentPanelMessage,
  AgentPanelTab,
  AgentToolMessage,
  AgentTurnFooter,
  AgentTurnStatus,
} from './types'

const TURN_FAILED = '这一轮没有跑完'
const TURN_RATE_LIMITED = '发送太频繁，稍后再试'
const CONVERSATION_UNREADABLE = '对话暂时未能加载，请重新加载。'

const RECONNECT_DELAYS_MS = [0, 500, 2_000, 5_000]

/** 登录后 scope 会变，所以每次现算，不缓存。 */
const conversationKey = () => scopedStorageName(AGENT_CONVERSATION_KEY)

export interface AgentState {
  open: boolean
  tab: AgentPanelTab
  conversationId: string | null
  conversations: AgentConversationView[]
  messages: AgentPanelMessage[]
  turns: Record<string, AgentTurnFooter>
  turn: AgentTurnStatus
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
  ): Promise<void>
  abort(): Promise<void>
  /** 画布冲突后由用户把那张结果卡的产出放进画布。 */
  placeOnCanvas(messageId: string): Promise<void>
}

function mergeTurn(
  turns: Record<string, AgentTurnFooter>,
  turnId: string,
  patch: Partial<AgentTurnFooter>,
): Record<string, AgentTurnFooter> {
  return { ...turns, [turnId]: { ...turns[turnId], turnId, ...patch } }
}

function replaceOrAppend(
  messages: AgentPanelMessage[],
  message: AgentPanelMessage,
): AgentPanelMessage[] {
  const index = messages.findIndex((one) => one.id === message.id)
  if (index < 0) return [...messages, message]
  return messages.map((one, at) => (at === index ? message : one))
}

function toolCard(block: AgentToolResultBlock, id: string, turnId: string): AgentToolMessage {
  return {
    kind: 'tool',
    id,
    turnId,
    toolCallId: block.toolCallId,
    title: block.title,
    ...(block.prompt ? { prompt: block.prompt } : {}),
    status: block.status,
    ...(block.artifacts ? { artifacts: block.artifacts } : {}),
    ...(block.anchorObjectId ? { anchorObjectId: block.anchorObjectId } : {}),
    ...(block.message ? { message: block.message } : {}),
  }
}

function clarificationCard(
  block: AgentClarificationBlock,
  id: string,
  turnId: string,
): AgentClarificationMessage {
  return { kind: 'clarification', id, turnId, question: block.question, options: block.options }
}

function panelMessage(message: AgentMessageView): AgentPanelMessage {
  const result = message.content.find(
    (block): block is AgentToolResultBlock => block.type === 'toolResult',
  )
  if (result) return toolCard(result, message.id, message.turnId)
  const asked = message.content.find(
    (block): block is AgentClarificationBlock => block.type === 'clarification',
  )
  if (asked) return clarificationCard(asked, message.id, message.turnId)
  return {
    kind: 'text',
    id: message.id,
    turnId: message.turnId,
    role: message.role,
    text: agentMessageText(message),
    streaming: false,
  }
}

/**
 * 可作答的只有末尾那一条：澄清之后一旦有用户消息，它就已经作过答。
 * 回填的答案本身就是那条用户消息，所以不必另存作答状态。
 */
export function answerableClarificationId(messages: readonly AgentPanelMessage[]): string | null {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at]!
    if (message.kind === 'text' && message.role === 'user') return null
    if (message.kind === 'clarification') return message.id
  }
  return null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const failPatch = (state: AgentState, message = TURN_FAILED) => ({
  turn: 'failed' as const,
  activeTurn: null,
  error: message,
  // 半截的回复撤掉；起轮前就失败的那条先上屏的用户消息也撤掉——草稿还在输入框里，
  // 留着它屏幕上就有两份同样的话。
  messages: state.messages.filter((one) => one.kind !== 'text' || (!one.streaming && !one.pending)),
})

/**
 * 这个会话有没有"开始"：敲下回车那条先上屏的消息也算。欢迎页据此让位——
 * 发送是乐观的，视图不等服务端确认；起轮失败会把那条撤回，欢迎页随之回来。
 */
export function conversationStarted(messages: readonly AgentPanelMessage[]): boolean {
  return messages.length > 0
}

export type AgentActivityPhase = 'sending' | 'thinking' | 'executing'

/**
 * 进行中这一轮此刻在干什么，给对话末尾的状态行用。文字一旦在流就返回 null：
 * 正文自己就是最好的进度。
 */
export function agentActivityPhase(
  state: Pick<AgentState, 'turn' | 'activeTurn' | 'messages'>,
): AgentActivityPhase | null {
  if (state.turn !== 'running') return null
  if (!state.activeTurn) return 'sending'
  const last = state.messages[state.messages.length - 1]
  if (last?.kind === 'tool' && last.status === 'running') return 'executing'
  if (last?.kind === 'text' && last.role === 'assistant' && last.streaming && last.text) return null
  return 'thinking'
}

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

  /** 事件按 id 幂等：重连重发的帧、以及续播重放的整轮，都要落到同一个结果上。 */
  const apply = (
    event: AgentTurnEvent,
    pendingUserText: string | null,
    turnId: string,
    turnDelivery: TurnArtifactDelivery,
  ) => {
    if (turnDelivery.isCurrent())
      set((state) => {
        switch (event.type) {
          case 'turnStart':
            return {
              activeTurn: { turnId: event.turnId },
              turns: mergeTurn(
                state.turns,
                event.turnId,
                event.reservedCredits === undefined
                  ? {}
                  : { reservedCredits: event.reservedCredits },
              ),
              messages: state.messages.some((one) => one.id === event.userMessageId)
                ? state.messages
                : [
                    // 先上屏的那条换成服务端的 id；同一轮不会有第二条待确认的。
                    ...state.messages.filter((one) => one.kind !== 'text' || !one.pending),
                    {
                      kind: 'text' as const,
                      id: event.userMessageId,
                      turnId,
                      role: 'user' as const,
                      text: pendingUserText ?? '',
                      streaming: false,
                    },
                  ],
            }
          case 'assistantStart':
            return {
              messages: replaceOrAppend(state.messages, {
                kind: 'text',
                id: event.messageId,
                turnId,
                role: 'assistant',
                text: '',
                streaming: true,
              }),
            }
          case 'interjection':
            return {
              messages: replaceOrAppend(state.messages, {
                kind: 'text',
                id: event.messageId,
                turnId,
                role: 'user',
                text: event.text,
                streaming: false,
              }),
            }
          case 'textDelta':
            return {
              messages: state.messages.map((one) =>
                one.kind === 'text' && one.id === event.messageId
                  ? { ...one, text: one.text + event.delta }
                  : one,
              ),
            }
          case 'toolStart':
            return {
              messages: replaceOrAppend(state.messages, {
                kind: 'tool',
                id: event.messageId,
                turnId,
                toolCallId: event.toolCallId,
                title: event.title,
                ...(event.prompt ? { prompt: event.prompt } : {}),
                status: 'running',
                ...(event.anchorObjectId ? { anchorObjectId: event.anchorObjectId } : {}),
              }),
            }
          case 'toolProgress':
            return {
              messages: state.messages.map((one) =>
                one.kind === 'tool' && one.id === event.messageId
                  ? { ...one, stage: event.stage }
                  : one,
              ),
            }
          case 'clarification':
            return {
              messages: replaceOrAppend(
                state.messages,
                clarificationCard(event, event.messageId, turnId),
              ),
            }
          case 'toolEnd':
            return {
              messages: replaceOrAppend(
                state.messages,
                toolCard({ ...event, type: 'toolResult' }, event.messageId, turnId),
              ),
            }
          case 'turnEnd': {
            const turns = mergeTurn(state.turns, event.turnId, {
              durationMs: event.durationMs,
              stopReason: event.stopReason,
              ...(event.cost ? { cost: event.cost } : {}),
            })
            if (event.stopReason === 'failed') return { ...failPatch(state), turns }
            return {
              turn: 'idle' as const,
              activeTurn: null,
              turns,
              messages: state.messages.map((one) =>
                one.kind === 'text' && one.streaming ? { ...one, streaming: false } : one,
              ),
            }
          }
        }
      })
    // 工具一起跑画布就占好位、镜头跟过去；产物到了落进这些位，没跑成就在原地标错。
    if (event.type === 'toolStart' && event.outputCount) {
      turnDelivery.reserve(event.messageId, {
        // 数量来自服务端；按协议上限收口，坏值不会在画布上铺出一片空框。
        count: Math.min(AGENT_IMAGE_MAX_N, event.outputCount),
        title: event.title,
        ...(event.anchorObjectId ? { anchorObjectId: event.anchorObjectId } : {}),
      })
    }
    if (event.type === 'toolEnd') {
      const message = toolCard({ ...event, type: 'toolResult' }, event.messageId, turnId)
      if (event.status === 'failed') turnDelivery.failed(event.messageId, event.message)
      else if (message?.kind === 'tool' && message.artifacts?.length) turnDelivery.enqueue(message)
      else turnDelivery.discard(event.messageId)
    }
  }

  const fail = (message?: string) => set((state) => failPatch(state, message))

  const followers = new Map<string, TurnArtifactDelivery>()

  /** 跟一轮到底：流断了就带断点重连，直到读到终帧或者一直接不上。 */
  const follow = async (
    conversationId: string,
    frames: AsyncGenerator<AgentFrame>,
    pendingUserText: string | null,
    turnDelivery: TurnArtifactDelivery,
    resumedTurnId = '',
  ) => {
    const previous = followers.get(conversationId)
    followers.set(conversationId, turnDelivery)
    if (previous && previous !== turnDelivery) await previous.settled()
    const canContinue = () =>
      followers.get(conversationId) === turnDelivery && turnDelivery.canContinue()
    let source = frames
    let seen = 0
    let turnId = resumedTurnId
    try {
      for (let attempt = 0; ; attempt += 1) {
        if (!canContinue()) return
        try {
          for await (const frame of source) {
            if (!canContinue()) return
            if (frame.id !== null && frame.id <= seen) continue
            if (frame.id !== null) {
              seen = frame.id
              attempt = -1
            }
            if (frame.event.type === 'turnStart') turnId = frame.event.turnId
            apply(frame.event, pendingUserText, turnId, turnDelivery)
            if (frame.event.type === 'turnEnd') return
          }
        } catch (thrown) {
          if (!canContinue()) return
          if (thrown instanceof AgentRequestError && thrown.status === 404) break
          if (thrown instanceof AgentRequestError && thrown.status === 429) {
            if (turnDelivery.isCurrent()) fail(TURN_RATE_LIMITED)
            return
          }
        }
        const active = turnId ? { turnId } : null
        const delay = RECONNECT_DELAYS_MS[Math.max(attempt, 0)]
        if (!active || delay === undefined) break
        await sleep(delay)
        if (!canContinue()) return
        source = resumeTurn(conversationId, active.turnId, seen)
      }
      if (turnDelivery.isCurrent() && get().turn === 'running') fail()
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
            activeTurn: null,
            error: '这段对话已不可用，画布和草稿仍保留，可以继续创作。',
          })
        } catch {
          if (isCurrent()) {
            set({ historyLoading: false, historyFailed: true })
            fail(CONVERSATION_UNREADABLE)
          }
        }
      } else if (gone) get().startNewConversation()
      else fail(CONVERSATION_UNREADABLE)
      return
    }
    set({
      historyLoading: false,
      historyFailed: false,
      messages: state.messages.map(panelMessage),
      turns: Object.fromEntries(state.turns.map((one) => [one.turnId, one])),
    })
    void delivery.restore(get().messages)
    const active = state.activeTurn?.turnId ?? turnId
    if (!active) return
    set({ turn: 'running', error: null, activeTurn: { turnId: active } })
    const turnDelivery = delivery.beginTurn()
    await follow(conversationId, resumeTurn(conversationId, active, 0), null, turnDelivery, active)
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
  const showProject = (project: { id: string; conversationId: string | null }) => {
    delivery.reset()
    useCanvasProjectStore.getState().activate(project.id)
    // 清掉旧消息后再发布新画布，挂载通知不会把旧产物投到新项目。
    set({
      conversationId: project.conversationId,
      messages: [],
      turns: {},
      turn: 'idle',
      activeTurn: null,
      error: null,
      historyFailed: false,
      historyLoading: false,
      loaded: true,
      tab: 'chat',
      open: true,
    })
    selectCanvasWorkspace(project.conversationId)
    if (project.conversationId) void openConversation(project.conversationId)
  }
  const saveCurrentProject = async () => {
    const project = currentCanvasProject()
    const draft = agentDraft(
      get().conversationId,
      project?.id,
      project?.sceneKey === canvasSceneKey(null),
    )
    await draft.ready
    await draft.flush()
    if (draft.getSnapshot().error) throw new Error('draft_save_failed')
    const workspace = currentCanvasWorkspace()
    await workspace.ready
    if (!(await workspace.flush())) throw new Error('save_failed')
  }
  const createProject = async () => {
    await saveCurrentProject()
    const project = await useCanvasProjectStore.getState().create()
    showProject(project)
    return true
  }

  return {
    open: true,
    tab: 'chat',
    conversationId: null,
    conversations: [],
    messages: [],
    turns: {},
    turn: 'idle',
    activeTurn: null,
    error: null,
    loaded: false,
    historyLoading: false,
    historyFailed: false,
    panelWidth: readPanelWidth(),

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
          useStore.getState().showToast('项目创建失败，当前内容已保留，请重试。', 'error')
          return false
        }
      })
    },

    async selectProject(projectId, isCurrent = () => true) {
      return changeProject(async () => {
        const project = useCanvasProjectStore
          .getState()
          .projects.find((one) => one.id === projectId)
        if (!project) return false
        try {
          await saveCurrentProject()
        } catch {
          useStore.getState().showToast('当前项目未能保存，内容已保留，请重试。', 'error')
          return false
        }
        if (!isCurrent()) return false
        showProject(project)
        return true
      })
    },

    async deleteProject(projectId) {
      return changeProject(async () => {
        conversationListRevision += 1
        const projects = useCanvasProjectStore.getState()
        const project = projects.projects.find((one) => one.id === projectId)
        if (!project) return false
        try {
          if (project.cloud) throw new Error('cloud_project_delete_unavailable')
          if (project.id === projects.activeId && get().turn === 'running') throw new Error('busy')
          await saveCurrentProject()
          await prepareCanvasRemoval(project.sceneKey)
          if (project.conversationId) {
            try {
              const history = await fetchMessages(project.conversationId)
              if (history.activeTurn) throw new Error('busy')
              await removeConversation(project.conversationId)
            } catch (error) {
              if (!(error instanceof AgentRequestError && error.status === 404)) throw error
            }
          }
          if (project.id === projects.activeId) await createProject()
          await removeProjectDraft(projectId, project.conversationId)
          await projects.remove(projectId)
          forgetCanvasWorkspace(project.sceneKey)
          set((state) => ({
            conversations: state.conversations.filter((one) => one.id !== project.conversationId),
          }))
          return true
        } catch (error) {
          useStore
            .getState()
            .showToast(
              error instanceof Error && error.message === 'busy'
                ? '项目仍有任务运行，完成后再删除。'
                : '项目删除失败，请重试。',
              'error',
            )
          return false
        } finally {
          conversationListRevision += 1
        }
      })
    },

    async send(text, references = [], onAccepted) {
      if (changingProject || get().historyLoading || get().historyFailed) return
      const trimmed = text.trim()
      if (!trimmed) return

      const active = get().activeTurn
      const conversationId = get().conversationId
      if (get().turn === 'running' && active && conversationId) {
        try {
          await interjectTurn(conversationId, active.turnId, trimmed, references)
          onAccepted?.()
          if (get().conversationId === conversationId) set({ error: null })
        } catch {
          if (get().conversationId === conversationId)
            set({ error: '插话未发送成功，草稿已保留，请重试。' })
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
      let target = conversationId
      try {
        if (!target) {
          target = (await createConversation()).id
          if (!turnDelivery.isCurrent()) {
            await turnDelivery.settled()
            return
          }
          if (!(await bindNewCanvasWorkspace(target))) {
            if (turnDelivery.isCurrent()) fail('画布未能保存到新会话，请重试。原画布和草稿已保留。')
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
        }
      } catch {
        if (turnDelivery.isCurrent()) fail()
        await turnDelivery.settled()
        return
      }
      // 起轮这一刻的参数快照：轮跑到一半用户改了 chip，改的是下一轮，不该追改这一轮。
      const { params, settings } = useStore.getState()
      const model = clientProfileToApiProfile(getActiveApiProfile(settings)).model
      const turnParams = toAgentTurnParams(params, model)
      // 起轮这一步的失败不在 `follow` 的重连范围里：请求没发出去就没有轮可以接。
      let outcome: StartTurnOutcome
      try {
        outcome = await startTurn(target, trimmed, references, turnParams)
      } catch (thrown) {
        if (turnDelivery.isCurrent())
          fail(
            thrown instanceof AgentRequestError && thrown.status === 429
              ? TURN_RATE_LIMITED
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
          await follow(target, outcome.frames, trimmed, turnDelivery)
        } else await turnDelivery.settled()
        return
      }
      if (outcome.kind === 'alreadyRunning') {
        // 别的标签页已经在这个会话里跑轮了。它那条用户消息只在服务端，先把历史读回来再续播。
        await turnDelivery.settled()
        await openConversation(target, outcome.turnId)
        if (get().conversationId === target)
          set({ error: '会话中已有任务运行，本次消息未发送，草稿已保留。' })
        return
      }
      onAccepted?.()
      await follow(target, outcome.frames, trimmed, turnDelivery)
      if (firstTurn) await get().refreshConversations()
    },

    async abort() {
      const active = get().activeTurn
      const conversationId = get().conversationId
      if (!active || !conversationId) return
      await abortTurn(conversationId, active.turnId)
    },

    async placeOnCanvas(messageId) {
      const message = get().messages.find((one) => one.id === messageId)
      if (message?.kind !== 'tool') return
      if (message.status === 'succeeded' && message.artifacts?.length)
        await delivery.placeOnCanvas(message)
    },
  }
})

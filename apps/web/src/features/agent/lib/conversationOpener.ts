import type { AgentActiveTurnView } from '@image-playground/shared'
import { i18next } from '../../../i18n'
import type { AgentPanelMessage, AgentTurnFooter, ReturnedMessagesErrorCode } from '../types'
import { type AgentConversationState, AgentRequestError, type AgentTurnSource } from './agentClient'
import type { AgentPanelState } from './panelMessages'
import { turnSource } from './turnFollower'
import { type AgentTurnFields, applyTurnSessionEvent } from './turnSession'

const CONVERSATION_UNREADABLE = () => i18next.t('error.conversationUnreadable', { ns: 'agent' })
const CONVERSATION_GONE = () => i18next.t('error.conversationGone', { ns: 'agent' })

/** 打开会话读写的那部分 store 状态。 */
export interface ConversationOpenerState extends AgentTurnFields {
  readonly conversationId: string | null
  readonly messages: AgentPanelMessage[]
  readonly turns: Record<string, AgentTurnFooter>
  readonly activeTurn: AgentActiveTurnView | null
  readonly error: string | null
  readonly errorDiagnostic: Record<string, unknown> | null
  readonly historyCached: boolean
  readonly historyLoading: boolean
  readonly historyFailed: boolean
  readonly returnedMessagesPending: boolean
  readonly returnedMessagesError: ReturnedMessagesErrorCode | null
}

/** 这个会话的本机显示快照；绑定后它就是面板写入的目标。 */
export interface ConversationSnapshotCache {
  isCurrent(): boolean
  read(): Promise<AgentPanelState | null>
  write(panel: AgentPanelState): Promise<void>
}

/** 打开会话时关心的那个画布项目：它挂着的会话被服务端判没了，要从项目上摘掉。 */
export interface ConversationOpenerProject {
  readonly id: string
  readonly conversationId?: string | null
}

export interface ConversationOpenerDeps {
  readonly get: () => ConversationOpenerState
  readonly set: (patch: Partial<ConversationOpenerState>) => void
  /** 换会话时整份清空的补丁（store 的 `sessionReset`）。 */
  readonly sessionReset: (conversationId: string | null) => Partial<ConversationOpenerState>
  /** 交付换代，返回「还是这一代」的判断。 */
  readonly resetDelivery: () => () => boolean
  readonly fetchMessages: (conversationId: string) => Promise<AgentConversationState>
  /** 改认这个会话为本机快照写入目标。 */
  readonly bindCache: (conversationId: string) => ConversationSnapshotCache
  /** 会话已不存在：删掉它的本机快照。 */
  readonly forgetCache: (conversationId: string) => Promise<void>
  /** 换会话后释放空闲的运行卡来源；必须在清空面板的那次 `set` 之后。 */
  readonly releaseRunOrigins: () => void
  readonly selectWorkspace: (conversationId: string) => void
  readonly adoptSnapshot: (conversationId: string, taken: AgentConversationState) => void
  /** 停止后退回的消息补回输入框（store 的 `recoverReturnedMessages`）。 */
  readonly recoverReturnedMessages: (conversationId: string) => Promise<unknown>
  /** 发送途中丢掉的那几条补发。 */
  readonly resumeOutgoing: (projectId: string) => void
  /** 挂上仍在跑的那一轮，跟到终局。 */
  readonly followActive: (conversationId: string, source: AgentTurnSource) => Promise<void>
  readonly fail: (message?: string) => void
  readonly startNewConversation: () => void
  readonly project: {
    readonly current: () => ConversationOpenerProject | undefined
    /** 把会话从项目上摘掉（写库）。 */
    readonly detach: (projectId: string) => Promise<void>
    readonly open: (projectId: string) => void
  }
}

/**
 * 读回会话历史并挂上仍在跑的那一轮。切会话、以及起轮撞上别的标签页时走的都是这一条。
 * `turnId` 是起轮的 409 给出的兜底：历史里的 activeTurn 更新，但那一轮可能在这次读取之前
 * 刚好跑完——续播端点对已经结束的轮同样重放，用户照样看得到它的内容。
 *
 * 本机快照只在服务端历史回来之前、面板还空着时当预览；服务端历史一到就以它为准。
 */
export function createConversationOpener(deps: ConversationOpenerDeps) {
  const { get, set } = deps

  return async function openConversation(conversationId: string, turnId?: string) {
    const currentDelivery = deps.resetDelivery()
    const owner = deps.bindCache(conversationId)
    const isCurrent = () => currentDelivery() && owner.isCurrent()
    const same = get().conversationId === conversationId
    set({
      // 换会话：草稿卡上改过的字、任务进度这些都跟着那个会话走，不带进新的。
      ...(same ? { conversationId } : deps.sessionReset(conversationId)),
      error: null,
      errorDiagnostic: null,
      ...applyTurnSessionEvent(get(), 'finish'),
      activeTurn: null,
      historyCached: same && get().historyCached,
      historyLoading: true,
      historyFailed: false,
      returnedMessagesPending: false,
      returnedMessagesError: null,
    })
    if (!same) deps.releaseRunOrigins()
    deps.selectWorkspace(conversationId)
    let remoteSettled = false
    void owner.read().then((panel) => {
      if (!panel || !isCurrent() || remoteSettled || get().messages.length > 0) return
      set({ ...panel, historyCached: true })
    })
    let state: AgentConversationState
    try {
      state = await deps.fetchMessages(conversationId)
      remoteSettled = true
      if (!isCurrent()) return
    } catch (thrown) {
      if (!isCurrent()) return
      // 只有服务端明说「没有」或「不是你的」才忘掉会话：其它失败（旧 bundle 打新服务端的 400、
      // 5xx、断网）里会话还在，忘掉它等于把用户的历史无声弄丢，报错让用户知道是读不到。
      const gone =
        thrown instanceof AgentRequestError && (thrown.status === 404 || thrown.status === 403)
      if (!gone) set({ historyLoading: false, historyFailed: true })
      const project = deps.project.current()
      if (gone) {
        remoteSettled = true
        set({ messages: [], turns: {}, historyCached: false })
        void deps.forgetCache(conversationId)
      }
      if (gone && project?.conversationId === conversationId) {
        try {
          await deps.project.detach(project.id)
          if (!isCurrent()) return
          deps.project.open(project.id)
          set({ ...deps.sessionReset(null), error: CONVERSATION_GONE(), errorDiagnostic: null })
          deps.releaseRunOrigins()
        } catch {
          if (isCurrent()) {
            set({ historyLoading: false, historyFailed: true })
            deps.fail(CONVERSATION_UNREADABLE())
          }
        }
      } else if (gone) deps.startNewConversation()
      else deps.fail(CONVERSATION_UNREADABLE())
      return
    }
    deps.adoptSnapshot(conversationId, state)
    set({ historyCached: false, historyLoading: false, historyFailed: false })
    void owner.write({ messages: get().messages, turns: get().turns })
    await deps.recoverReturnedMessages(conversationId)
    if (!isCurrent()) return
    const active = state.activeTurn?.turnId ?? turnId
    if (!active) {
      // 历史读回来了、也没有在跑的轮：发送途中丢掉的那几条现在补发。
      const project = deps.project.current()
      if (project?.conversationId === conversationId) deps.resumeOutgoing(project.id)
      return
    }
    set({ ...applyTurnSessionEvent(get(), 'ensureRunning'), activeTurn: { turnId: active } })
    await deps.followActive(conversationId, turnSource(state, active))
  }
}

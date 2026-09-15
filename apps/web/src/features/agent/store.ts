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
import { AGENT_TURN_MAX_N, agentMessageText } from '@image-playground/shared'
import { create } from 'zustand'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../lib/apiProfiles'
import { AGENT_CONVERSATION_KEY, safeLocalStorage, scopedStorageName } from '../../lib/authScope'
import { useStore } from '../../store'
import { bindNewCanvasWorkspace, selectCanvasWorkspace } from '../canvas/lib/workspaces'
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
import { bindNewAgentDraft } from './lib/drafts'
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
const CONVERSATION_UNREADABLE = '这个会话读不回来，稍后再试'

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
  messages: state.messages.filter((one) => one.kind !== 'text' || !one.streaming),
})

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
    set((state) => {
      switch (event.type) {
        case 'turnStart':
          return {
            activeTurn: { turnId: event.turnId },
            turns: mergeTurn(
              state.turns,
              event.turnId,
              event.reservedCredits === undefined ? {} : { reservedCredits: event.reservedCredits },
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
        count: Math.min(AGENT_TURN_MAX_N, event.outputCount),
        ...(event.anchorObjectId ? { anchorObjectId: event.anchorObjectId } : {}),
      })
    }
    if (event.type === 'toolEnd') {
      const message = get().messages.find((one) => one.id === event.messageId)
      if (event.status === 'failed') turnDelivery.failed(event.messageId, event.message)
      else if (message?.kind === 'tool' && message.artifacts?.length) turnDelivery.enqueue(message)
      else turnDelivery.discard(event.messageId)
    }
  }

  const fail = (message?: string) => set((state) => failPatch(state, message))

  /** 跟一轮到底：流断了就带断点重连，直到读到终帧或者一直接不上。 */
  const follow = async (
    conversationId: string,
    frames: AsyncGenerator<AgentFrame>,
    pendingUserText: string | null,
    turnDelivery: TurnArtifactDelivery,
    resumedTurnId = '',
  ) => {
    let source = frames
    let seen = 0
    let turnId = resumedTurnId
    try {
      for (let attempt = 0; ; attempt += 1) {
        if (!turnDelivery.isCurrent()) return
        try {
          for await (const frame of source) {
            if (!turnDelivery.isCurrent()) return
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
          if (!turnDelivery.isCurrent()) return
          if (thrown instanceof AgentRequestError && thrown.status === 404) break
          if (thrown instanceof AgentRequestError && thrown.status === 429) {
            fail(TURN_RATE_LIMITED)
            return
          }
        }
        const active = get().activeTurn
        const delay = RECONNECT_DELAYS_MS[Math.max(attempt, 0)]
        if (!active || delay === undefined) break
        await sleep(delay)
        if (!turnDelivery.isCurrent()) return
        source = resumeTurn(conversationId, active.turnId, seen)
      }
      if (get().turn === 'running') fail()
    } finally {
      await turnDelivery.settled()
    }
  }

  /**
   * 读回会话历史并挂上仍在跑的那一轮。切会话、以及起轮撞上别的标签页时走的都是这一条。
   * `turnId` 是起轮的 409 给出的兜底：历史里的 activeTurn 更新，但那一轮可能在这次读取之前
   * 刚好跑完——续播端点对已经结束的轮同样重放，用户照样看得到它的内容。
   */
  const openConversation = async (conversationId: string, turnId?: string) => {
    const isCurrent = delivery.reset()
    selectCanvasWorkspace(conversationId)
    set({ conversationId, messages: [], turns: {}, error: null, turn: 'idle', activeTurn: null })
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
      if (gone) get().startNewConversation()
      else fail(CONVERSATION_UNREADABLE)
      return
    }
    set({
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
        ...(conversationId ? [get().selectConversation(conversationId)] : []),
      ])
    },

    async refreshConversations() {
      try {
        set({ conversations: await fetchConversations() })
      } catch {
        // 列表读不回来不该拖垮面板，留着上一份。
      }
    },

    async selectConversation(conversationId) {
      if (get().turn === 'running') return
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
      if (get().turn === 'running') return
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
      })
    },

    async send(text, references = [], onAccepted) {
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
            fail('画布未能保存到新会话，请重试。原画布和草稿已保留。')
            await turnDelivery.settled()
            return
          }
          safeLocalStorage.setItem(conversationKey(), target)
          bindNewAgentDraft(target)
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

import type {
  AgentActiveTurnView,
  AgentConversationView,
  AgentFrame,
  AgentTurnEvent,
} from '@image-playground/shared'
import { agentMessageText } from '@image-playground/shared'
import { create } from 'zustand'
import { AGENT_CONVERSATION_KEY, safeLocalStorage, scopedStorageName } from '../../lib/authScope'
import {
  AgentRequestError,
  abortTurn,
  createConversation,
  fetchConversations,
  fetchMessages,
  interjectTurn,
  removeConversation,
  resumeTurn,
  startTurn,
} from './lib/agentClient'
import type { AgentPanelMessage, AgentPanelTab, AgentTurnStatus } from './types'

const TURN_FAILED = '这一轮没有跑完'
const TURN_RATE_LIMITED = '发送太频繁，稍后再试'

const RECONNECT_DELAYS_MS = [0, 500, 2_000, 5_000]

/** 登录后 scope 会变，所以每次现算，不缓存。 */
const conversationKey = () => scopedStorageName(AGENT_CONVERSATION_KEY)

export interface AgentState {
  open: boolean
  tab: AgentPanelTab
  conversationId: string | null
  conversations: AgentConversationView[]
  messages: AgentPanelMessage[]
  turn: AgentTurnStatus
  /** 正在跟的那一轮；中止与插话都指向它。 */
  activeTurn: AgentActiveTurnView | null
  error: string | null
  loaded: boolean
  expanded: Record<string, boolean>

  setOpen(open: boolean): void
  setTab(tab: AgentPanelTab): void
  toggleExpanded(messageId: string): void
  /** 读回会话列表与上次那个会话的消息，并挂回仍在进行的那一轮。 */
  load(): Promise<void>
  refreshConversations(): Promise<void>
  selectConversation(conversationId: string): Promise<void>
  deleteConversation(conversationId: string): Promise<void>
  startNewConversation(): void
  /** 空闲时起一轮；轮进行中则是插话。 */
  send(text: string): Promise<void>
  abort(): Promise<void>
}

function replaceOrAppend(
  messages: AgentPanelMessage[],
  message: AgentPanelMessage,
): AgentPanelMessage[] {
  const index = messages.findIndex((one) => one.id === message.id)
  if (index < 0) return [...messages, message]
  return messages.map((one, at) => (at === index ? message : one))
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const failPatch = (state: AgentState, message = TURN_FAILED) => ({
  turn: 'failed' as const,
  activeTurn: null,
  error: message,
  messages: state.messages.filter((one) => !one.streaming),
})

export const useAgentStore = create<AgentState>((set, get) => {
  /** 事件按 id 幂等：重连重发的帧、以及续播重放的整轮，都要落到同一个结果上。 */
  const apply = (event: AgentTurnEvent, pendingUserText: string | null) => {
    set((state) => {
      switch (event.type) {
        case 'turnStart':
          return {
            activeTurn: { turnId: event.turnId },
            messages: state.messages.some((one) => one.id === event.userMessageId)
              ? state.messages
              : [
                  ...state.messages,
                  {
                    id: event.userMessageId,
                    role: 'user' as const,
                    text: pendingUserText ?? '',
                    streaming: false,
                  },
                ],
          }
        case 'assistantStart':
          return {
            messages: replaceOrAppend(state.messages, {
              id: event.messageId,
              role: 'assistant',
              text: '',
              streaming: true,
            }),
          }
        case 'interjection':
          return {
            messages: replaceOrAppend(state.messages, {
              id: event.messageId,
              role: 'user',
              text: event.text,
              streaming: false,
            }),
          }
        case 'textDelta':
          return {
            messages: state.messages.map((one) =>
              one.id === event.messageId ? { ...one, text: one.text + event.delta } : one,
            ),
          }
        case 'turnEnd':
          if (event.stopReason === 'failed') return failPatch(state)
          return {
            turn: 'idle' as const,
            activeTurn: null,
            messages: state.messages.map((one) =>
              one.streaming ? { ...one, streaming: false } : one,
            ),
          }
      }
    })
  }

  const fail = (message?: string) => set((state) => failPatch(state, message))

  /** 跟一轮到底：流断了就带断点重连，直到读到终帧或者一直接不上。 */
  const follow = async (
    conversationId: string,
    frames: AsyncGenerator<AgentFrame>,
    pendingUserText: string | null,
  ) => {
    let source = frames
    let seen = 0
    // 重连预算按「多久没有进展」算：长轮里断上几次但每次都续上，不该被判失败。
    for (let attempt = 0; ; attempt += 1) {
      try {
        for await (const frame of source) {
          if (frame.id !== null && frame.id <= seen) continue
          if (frame.id !== null) {
            seen = frame.id
            attempt = -1
          }
          apply(frame.event, pendingUserText)
          if (frame.event.type === 'turnEnd') return
        }
      } catch (thrown) {
        // 轮已经不在了，再重连也接不上；其余的断流与请求失败都走重连。
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
      source = resumeTurn(conversationId, active.turnId, seen)
    }
    if (get().turn === 'running') fail()
  }

  return {
    open: true,
    tab: 'chat',
    conversationId: null,
    conversations: [],
    messages: [],
    turn: 'idle',
    activeTurn: null,
    error: null,
    loaded: false,
    expanded: {},

    setOpen: (open) => set({ open }),
    setTab: (tab) => set({ tab }),
    toggleExpanded: (messageId) =>
      set((state) => ({
        expanded: { ...state.expanded, [messageId]: !state.expanded[messageId] },
      })),

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
      set({ conversationId, messages: [], error: null })
      let state: Awaited<ReturnType<typeof fetchMessages>>
      try {
        state = await fetchMessages(conversationId)
      } catch {
        // 会话被删或换了身份：忘掉它，下一条消息开新会话。
        get().startNewConversation()
        return
      }
      set({
        messages: state.messages.map((message) => ({
          id: message.id,
          role: message.role,
          text: agentMessageText(message),
          streaming: false,
        })),
      })
      if (!state.activeTurn) return
      set({ turn: 'running', error: null, activeTurn: state.activeTurn })
      await follow(conversationId, resumeTurn(conversationId, state.activeTurn.turnId, 0), null)
    },

    async deleteConversation(conversationId) {
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
      safeLocalStorage.removeItem(conversationKey())
      set({ conversationId: null, messages: [], error: null })
    },

    async send(text) {
      const trimmed = text.trim()
      if (!trimmed) return

      const active = get().activeTurn
      const conversationId = get().conversationId
      if (get().turn === 'running' && active && conversationId) {
        await interjectTurn(conversationId, active.turnId, trimmed)
        return
      }

      // 首轮才会定标题、才会有新会话进列表；之后每轮再拉一次是白拉。
      const firstTurn = get().messages.length === 0
      set({ turn: 'running', error: null, activeTurn: null })
      let target = conversationId
      try {
        if (!target) {
          target = (await createConversation()).id
          safeLocalStorage.setItem(conversationKey(), target)
          set({ conversationId: target })
        }
      } catch {
        fail()
        return
      }
      await follow(target, startTurn(target, trimmed), trimmed)
      if (firstTurn) await get().refreshConversations()
    },

    async abort() {
      const active = get().activeTurn
      const conversationId = get().conversationId
      if (!active || !conversationId) return
      await abortTurn(conversationId, active.turnId)
    },
  }
})

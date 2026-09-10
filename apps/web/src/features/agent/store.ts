import type { AgentActiveTurnView, AgentFrame, AgentTurnEvent } from '@image-playground/shared'
import { agentMessageText } from '@image-playground/shared'
import { create } from 'zustand'
import { AGENT_CONVERSATION_KEY, safeLocalStorage, scopedStorageName } from '../../lib/authScope'
import {
  AgentRequestError,
  abortTurn,
  createConversation,
  fetchMessages,
  interjectTurn,
  resumeTurn,
  startTurn,
} from './lib/agentClient'
import type { AgentPanelMessage, AgentPanelTab, AgentTurnStatus } from './types'

const TURN_FAILED = '这一轮没有跑完'

const RECONNECT_DELAYS_MS = [0, 500, 2_000, 5_000]

/** 登录后 scope 会变，所以每次现算，不缓存。 */
const conversationKey = () => scopedStorageName(AGENT_CONVERSATION_KEY)

export interface AgentState {
  open: boolean
  tab: AgentPanelTab
  conversationId: string | null
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
  /** 读回上次会话的全部消息，并挂回仍在进行的那一轮。 */
  load(): Promise<void>
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

const failPatch = (state: AgentState) => ({
  turn: 'failed' as const,
  activeTurn: null,
  error: TURN_FAILED,
  messages: state.messages.filter((message) => !message.streaming),
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

  const fail = () => set(failPatch)

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
      const conversationId = safeLocalStorage.getItem(conversationKey())
      if (!conversationId) {
        set({ loaded: true })
        return
      }
      let state: Awaited<ReturnType<typeof fetchMessages>>
      try {
        state = await fetchMessages(conversationId)
      } catch {
        // 会话被删或换了身份：忘掉它，下一条消息开新会话。
        safeLocalStorage.removeItem(conversationKey())
        set({ conversationId: null, loaded: true })
        return
      }
      set({
        conversationId,
        loaded: true,
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

    async send(text) {
      const trimmed = text.trim()
      if (!trimmed) return

      const active = get().activeTurn
      const conversationId = get().conversationId
      if (get().turn === 'running' && active && conversationId) {
        await interjectTurn(conversationId, active.turnId, trimmed)
        return
      }

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
    },

    async abort() {
      const active = get().activeTurn
      const conversationId = get().conversationId
      if (!active || !conversationId) return
      await abortTurn(conversationId, active.turnId)
    },
  }
})

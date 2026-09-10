import { agentMessageText } from '@image-playground/shared'
import { create } from 'zustand'
import { AGENT_CONVERSATION_KEY, safeLocalStorage, scopedStorageName } from '../../lib/authScope'
import { createConversation, fetchMessages, streamTurn } from './lib/agentClient'
import type { AgentPanelMessage, AgentPanelTab, AgentTurnStatus } from './types'

const TURN_FAILED = '这一轮没有跑完'

/** 登录后 scope 会变，所以每次现算，不缓存。 */
const conversationKey = () => scopedStorageName(AGENT_CONVERSATION_KEY)

export interface AgentState {
  open: boolean
  tab: AgentPanelTab
  conversationId: string | null
  messages: AgentPanelMessage[]
  turn: AgentTurnStatus
  error: string | null
  loaded: boolean
  expanded: Record<string, boolean>

  setOpen(open: boolean): void
  setTab(tab: AgentPanelTab): void
  toggleExpanded(messageId: string): void
  /** 读回上次会话的全部消息；没有会话则留空，等第一条消息再建。 */
  load(): Promise<void>
  send(text: string): Promise<void>
}

export const useAgentStore = create<AgentState>((set, get) => ({
  open: true,
  tab: 'chat',
  conversationId: null,
  messages: [],
  turn: 'idle',
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
    try {
      const messages = await fetchMessages(conversationId)
      set({
        conversationId,
        loaded: true,
        messages: messages.map((message) => ({
          id: message.id,
          role: message.role,
          text: agentMessageText(message),
          streaming: false,
        })),
      })
    } catch {
      // 会话被删或换了身份：忘掉它，下一条消息开新会话。
      safeLocalStorage.removeItem(conversationKey())
      set({ conversationId: null, loaded: true })
    }
  },

  async send(text) {
    const trimmed = text.trim()
    if (!trimmed || get().turn === 'running') return

    const fail = () =>
      set((state) => ({
        turn: 'failed' as const,
        error: TURN_FAILED,
        messages: state.messages.filter((message) => !message.streaming),
      }))

    set({ turn: 'running', error: null })
    let conversationId = get().conversationId
    try {
      if (!conversationId) {
        conversationId = (await createConversation()).id
        safeLocalStorage.setItem(conversationKey(), conversationId)
        set({ conversationId })
      }

      for await (const event of streamTurn(conversationId, trimmed)) {
        if (event.type === 'turnStart') {
          set((state) => ({
            messages: [
              ...state.messages,
              { id: event.userMessageId, role: 'user', text: trimmed, streaming: false },
              { id: event.assistantMessageId, role: 'assistant', text: '', streaming: true },
            ],
          }))
        }
        if (event.type === 'textDelta') {
          set((state) => ({
            messages: state.messages.map((message) =>
              message.streaming ? { ...message, text: message.text + event.delta } : message,
            ),
          }))
        }
        if (event.type === 'turnEnd') {
          set((state) => ({
            turn: 'idle',
            messages: state.messages.map((message) =>
              message.streaming ? { ...message, streaming: false } : message,
            ),
          }))
        }
      }
    } catch {
      // 落到下面那条收敛：流没走到 turnEnd 就是失败。
    }
    // error 事件、异常、以及流在轮结束前断掉，三种情况都停在 running。
    if (get().turn === 'running') fail()
  },
}))

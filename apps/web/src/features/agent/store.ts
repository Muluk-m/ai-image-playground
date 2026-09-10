import { agentMessageText } from '@image-playground/shared'
import { create } from 'zustand'
import { isClientCapabilityEnabled } from '../../lib/clientCapabilities'
import { PANEL_MARGIN, PANEL_WIDTH } from './agentStyles'
import { createConversation, fetchMessages, streamTurn } from './lib/agentClient'
import type { AgentPanelMessage, AgentPanelTab, AgentTurnStatus } from './types'

const CONVERSATION_KEY = 'image-playground.agent_conversation_id'

const TURN_FAILED = '这一轮没有跑完'

function rememberConversation(id: string | null): void {
  try {
    if (id) localStorage.setItem(CONVERSATION_KEY, id)
    else localStorage.removeItem(CONVERSATION_KEY)
  } catch {
    // 隐私模式下读写会抛；换个标签页就没有历史，可接受。
  }
}

function rememberedConversation(): string | null {
  try {
    return localStorage.getItem(CONVERSATION_KEY)
  } catch {
    return null
  }
}

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

/** 面板浮在画布左侧，画布左下角的控件据此让开它；能力关闭时面板不存在，不让。 */
export function useAgentPanelInset(): number {
  const open = useAgentStore((state) => state.open)
  return open && isClientCapabilityEnabled('agent:chat') ? PANEL_MARGIN * 2 + PANEL_WIDTH : 0
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
    const conversationId = rememberedConversation()
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
      rememberConversation(null)
      set({ conversationId: null, loaded: true })
    }
  },

  async send(text) {
    const trimmed = text.trim()
    if (!trimmed || get().turn === 'running') return

    set({ turn: 'running', error: null })
    let conversationId = get().conversationId
    try {
      if (!conversationId) {
        conversationId = (await createConversation()).id
        rememberConversation(conversationId)
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
        if (event.type === 'error') {
          set((state) => ({
            turn: 'failed',
            error: TURN_FAILED,
            messages: state.messages.filter((message) => !message.streaming),
          }))
        }
      }
    } catch {
      set((state) => ({
        turn: 'failed',
        error: TURN_FAILED,
        messages: state.messages.filter((message) => !message.streaming),
      }))
      return
    }
    // 流断在轮结束之前也算失败，状态机不能停在 running。
    if (get().turn === 'running') {
      set((state) => ({
        turn: 'failed',
        error: TURN_FAILED,
        messages: state.messages.filter((message) => !message.streaming),
      }))
    }
  },
}))

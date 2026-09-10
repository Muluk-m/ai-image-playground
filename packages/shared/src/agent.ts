/**
 * 智能体对话协议（`/api/agent/*`）。一轮的事件流用 `text/event-stream`，
 * 每帧的 SSE id 是会话内单调递增的整数，供后续断线重放定位。
 */

export const AGENT_CONVERSATION_TITLE_MAX_CHARS = 60
export const AGENT_USER_MESSAGE_MAX_CHARS = 4_000
export const AGENT_DEVICE_ID_MIN_CHARS = 8
export const AGENT_DEVICE_ID_MAX_CHARS = 64

export type AgentMessageRole = 'user' | 'assistant'

export interface AgentTextBlock {
  readonly type: 'text'
  readonly text: string
}

/** 工具调用与工具结果块由后续的工具票追加，读路径按 `type` 分发。 */
export type AgentContentBlock = AgentTextBlock

export interface AgentMessageView {
  readonly id: string
  readonly turnId: string
  readonly role: AgentMessageRole
  readonly content: readonly AgentContentBlock[]
  readonly createdAt: number
}

export interface AgentConversationView {
  readonly id: string
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface AgentTurnStartEvent {
  readonly type: 'turnStart'
  readonly turnId: string
  readonly userMessageId: string
  readonly assistantMessageId: string
}

export interface AgentTextDeltaEvent {
  readonly type: 'textDelta'
  readonly delta: string
}

export interface AgentTurnEndEvent {
  readonly type: 'turnEnd'
  readonly turnId: string
  readonly durationMs: number
}

export interface AgentTurnErrorEvent {
  readonly type: 'error'
  readonly error: AgentTurnErrorCode
}

export type AgentTurnErrorCode = 'agent_upstream_error' | 'agent_run_failed'

export type AgentTurnEvent =
  | AgentTurnStartEvent
  | AgentTextDeltaEvent
  | AgentTurnEndEvent
  | AgentTurnErrorEvent

export interface AgentTurnFrame {
  readonly id: number
  readonly event: AgentTurnEvent
}

export function agentMessageText(message: AgentMessageView): string {
  return message.content
    .filter((block): block is AgentTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** 首轮消息即标题，超长截断；会话不支持改名，所以这是标题的唯一来源。 */
export function agentConversationTitle(firstUserMessage: string): string {
  const trimmed = firstUserMessage.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= AGENT_CONVERSATION_TITLE_MAX_CHARS) return trimmed
  return `${trimmed.slice(0, AGENT_CONVERSATION_TITLE_MAX_CHARS - 1)}…`
}

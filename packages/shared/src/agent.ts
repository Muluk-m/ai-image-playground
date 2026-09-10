/** 智能体对话协议（`/api/agent/*`）。一轮的事件流走 `text/event-stream`。 */

export const AGENT_CONVERSATION_TITLE_MAX_CHARS = 60
export const AGENT_USER_MESSAGE_MAX_CHARS = 4_000

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

/** 摘要正文的固定分节。用户原话不在这里：那一节由压缩模块从原文逐字取，不经模型。 */
export interface AgentCompactionNarrative {
  readonly completed: string
  readonly inProgress: string
  readonly decisions: string
  readonly artifacts: string
}

/** 会话上的上下文压缩私有状态。服务端自用，不进任何下发前端的视图。 */
export interface AgentCompactionRecord {
  readonly summary: AgentCompactionNarrative | null
  readonly anchor: { readonly lastMessageId: string; readonly coveredCount: number } | null
  readonly foldCount: number
  readonly failureCount: number
  readonly openedAt: number | null
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

/** 上游按 `stream_options.include_usage` 在末帧回的用量。中转网关不透传时是 null。 */
export interface AgentTurnUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface AgentTurnEndEvent {
  readonly type: 'turnEnd'
  readonly turnId: string
  readonly durationMs: number
  /** 本轮对话 token 的结算依据；null 表示上游没报，这一轮按 token 结不了账。 */
  readonly usage: AgentTurnUsage | null
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

/** 帧 id 在一条响应内单调递增。编码与解码放一处，免得线格式在两端各写一遍。 */
export function encodeAgentFrame(id: number, event: AgentTurnEvent): string {
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

export const AGENT_FRAME_SEPARATOR = /\r?\n\r?\n/

/** 一帧可以有多行 `data:`，按 SSE 规范拼回去；形状不对就丢，不让半截 JSON 进状态机。 */
export function parseAgentFrame(frame: string): AgentTurnEvent | null {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n')
  if (!data) return null
  try {
    return JSON.parse(data) as AgentTurnEvent
  } catch {
    return null
  }
}

export function agentTextFromBlocks(blocks: readonly { readonly type: string }[]): string {
  return blocks
    .filter((block): block is AgentTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

export function agentMessageText(message: AgentMessageView): string {
  return agentTextFromBlocks(message.content)
}

/** 首轮消息即标题，超长截断；会话不支持改名，所以这是标题的唯一来源。 */
export function agentConversationTitle(firstUserMessage: string): string {
  const trimmed = firstUserMessage.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= AGENT_CONVERSATION_TITLE_MAX_CHARS) return trimmed
  return `${trimmed.slice(0, AGENT_CONVERSATION_TITLE_MAX_CHARS - 1)}…`
}

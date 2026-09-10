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
}

/** 一轮里可以有多条助手消息：插话之后运行时会开新的一条。 */
export interface AgentAssistantStartEvent {
  readonly type: 'assistantStart'
  readonly messageId: string
}

export interface AgentTextDeltaEvent {
  readonly type: 'textDelta'
  readonly messageId: string
  readonly delta: string
}

/** 轮进行中追加的用户消息。 */
export interface AgentInterjectionEvent {
  readonly type: 'interjection'
  readonly messageId: string
  readonly text: string
}

/** 上游按 `stream_options.include_usage` 在末帧回的用量。中转网关不透传时是 null。 */
export interface AgentTurnUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

export type AgentTurnStopReason = 'completed' | 'aborted'

export interface AgentTurnEndEvent {
  readonly type: 'turnEnd'
  readonly turnId: string
  readonly durationMs: number
  readonly stopReason: AgentTurnStopReason
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
  | AgentAssistantStartEvent
  | AgentTextDeltaEvent
  | AgentInterjectionEvent
  | AgentTurnEndEvent
  | AgentTurnErrorEvent

/** 轮的最后一个事件。续播读到它就收流，不必再问轮是否还活着。 */
export function isAgentTurnTerminal(event: AgentTurnEvent): boolean {
  return event.type === 'turnEnd' || event.type === 'error'
}

/** 进行中的轮，`GET .../messages` 用它告诉刷新后的前端该挂回哪一轮。 */
export interface AgentActiveTurnView {
  readonly turnId: string
}

/** 轮事件的保留窗口。过期即清，续播只保证窗口内的轮能接上。 */
export const AGENT_TURN_EVENT_RETENTION_MS = 24 * 60 * 60 * 1_000

/**
 * 心跳间隔。Cloudflare 边缘对无字节的响应有读超时（524），一轮里模型的首字或
 * 工具执行都可能静默超过它，靠注释帧续命。
 */
export const AGENT_SSE_HEARTBEAT_MS = 15_000

/** SSE 注释帧：解析器忽略它，也不占事件 id。 */
export function agentHeartbeatFrame(): string {
  return ': ping\n\n'
}

/** 帧 id 是轮事件表里的会话内序号，重连带 `Last-Event-ID` 从它续播。 */
export function encodeAgentFrame(id: number, event: AgentTurnEvent): string {
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

export const AGENT_FRAME_SEPARATOR = /\r?\n\r?\n/

export interface AgentFrame {
  readonly id: number | null
  readonly event: AgentTurnEvent
}

/** 一帧可以有多行 `data:`，按 SSE 规范拼回去；形状不对就丢，不让半截 JSON 进状态机。 */
export function parseAgentFrame(frame: string): AgentFrame | null {
  const lines = frame.split(/\r?\n/)
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n')
  if (!data) return null
  const idLine = lines.find((line) => line.startsWith('id:'))
  const id = idLine ? Number(idLine.slice(3).trim()) : Number.NaN
  try {
    return { id: Number.isFinite(id) ? id : null, event: JSON.parse(data) as AgentTurnEvent }
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

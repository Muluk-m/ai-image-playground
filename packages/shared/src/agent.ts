/** 智能体对话协议（`/api/agent/*`）。一轮的事件流走 `text/event-stream`。 */

export const AGENT_CONVERSATION_TITLE_MAX_CHARS = 60
export const AGENT_USER_MESSAGE_MAX_CHARS = 4_000

export type AgentMessageRole = 'user' | 'assistant'

export interface AgentTextBlock {
  readonly type: 'text'
  readonly text: string
}

/** 智能体可调用的工具。生视频另有独立的票，往这里追加。 */
export type AgentToolName = 'generateImage' | 'editImage' | 'readLibrary'

/**
 * 一轮里用户在输入框附上的参考图。数组下标加一就是提示词里 `[image N]` 的 N，
 * 所以顺序不能在传输途中被重排。
 */
export interface AgentTurnReference {
  /** 画布对象 id 或素材的图片 id；模型改图时用它指认要改哪一张。 */
  readonly imageId: string
  readonly dataUrl: string
  /** 素材名，只用来让模型在回复里说人话。 */
  readonly name?: string
  /** 用户在这张图上画的遮罩；改图时自动带上，模型无从指定。 */
  readonly maskDataUrl?: string
}

export const AGENT_TURN_MAX_REFERENCES = 8

export type AgentToolStatus = 'succeeded' | 'failed'

/** 工具产出的一张图。`imageId` 同时是画布对象的 id，结果卡凭它定位到画布上同一个对象。 */
export interface AgentToolImage {
  readonly imageId: string
  readonly taskId: string
  readonly outputIndex: number
  readonly mime: string
  readonly width?: number
  readonly height?: number
}

/** 一次工具调用的最终结果。它单独占一条助手消息，所以翻历史时与文字回复各就各位。 */
export interface AgentToolResultBlock {
  readonly type: 'toolResult'
  readonly toolCallId: string
  readonly toolName: AgentToolName
  readonly status: AgentToolStatus
  /** 面板上这张卡的一行标签。 */
  readonly title: string
  readonly images?: readonly AgentToolImage[]
  /** 产出落画布时贴着这个对象放；缺席就落在视口中央。 */
  readonly anchorImageId?: string
  /** 失败原因，一句话。 */
  readonly message?: string
}

export type AgentContentBlock = AgentTextBlock | AgentToolResultBlock

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

/** 一次工具调用开始。`messageId` 是这次调用独占的助手消息，工具的三个事件都指向它。 */
export interface AgentToolStartEvent {
  readonly type: 'toolStart'
  readonly messageId: string
  readonly toolCallId: string
  readonly toolName: AgentToolName
  readonly title: string
}

/** 分钟级任务的中途进度。一轮里可以有多次工具调用，各自按 `toolCallId` 独立上报。 */
export interface AgentToolProgressEvent {
  readonly type: 'toolProgress'
  readonly messageId: string
  readonly toolCallId: string
  readonly stage: AgentToolStage
}

export type AgentToolStage = 'submitted' | 'running'

/** 与落库的结果块同形：断线后只续播尾巴时，前端手上可能没有这次调用的 `toolStart`。 */
export type AgentToolEndEvent = Omit<AgentToolResultBlock, 'type'> & {
  readonly type: 'toolEnd'
  readonly messageId: string
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

export type AgentTurnStopReason = 'completed' | 'aborted' | 'failed'

export type AgentTurnErrorCode = 'agent_upstream_error' | 'agent_run_failed' | 'agent_tool_failed'

/** 轮唯一的终帧。续播读到它就收流，不必再问轮是否还活着。 */
export interface AgentTurnEndEvent {
  readonly type: 'turnEnd'
  readonly turnId: string
  readonly durationMs: number
  readonly stopReason: AgentTurnStopReason
  readonly error?: AgentTurnErrorCode
  /** 本轮对话 token 的结算依据；null 表示上游没报，这一轮按 token 结不了账。 */
  readonly usage: AgentTurnUsage | null
}

export type AgentTurnEvent =
  | AgentTurnStartEvent
  | AgentAssistantStartEvent
  | AgentTextDeltaEvent
  | AgentToolStartEvent
  | AgentToolProgressEvent
  | AgentToolEndEvent
  | AgentInterjectionEvent
  | AgentTurnEndEvent

/** 进行中的轮，`GET .../messages` 用它告诉刷新后的前端该挂回哪一轮。 */
export interface AgentActiveTurnView {
  readonly turnId: string
}

/** 轮事件的保留窗口。过期即清，续播只保证窗口内的轮能接上。 */
export const AGENT_TURN_EVENT_RETENTION_MS = 24 * 60 * 60 * 1_000

/** Cloudflare 边缘对久无字节的响应判读超时（524），一轮的静默期靠注释帧续命。 */
export const AGENT_SSE_HEARTBEAT_MS = 15_000

/** 注释帧：解析器忽略它，也不占事件 id。 */
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

/** 工具结果回放给模型的形状：图片 id 让它下一轮还能指着同一张图说话。 */
export function agentToolResultSummary(block: AgentToolResultBlock): string {
  if (block.status === 'failed') return `${block.title}：失败（${block.message ?? '未知原因'}）`
  const ids = (block.images ?? []).map((image) => image.imageId).join(', ')
  return ids ? `${block.title}：完成，图片 ${ids}` : `${block.title}：完成`
}

/** 折行压成一行再截断，省略号占最后一格。 */
export function agentTitleLine(text: string, maxChars: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars - 1)}…`
}

/** 首轮消息即标题；会话不支持改名，所以这是标题的唯一来源。 */
export function agentConversationTitle(firstUserMessage: string): string {
  return agentTitleLine(firstUserMessage, AGENT_CONVERSATION_TITLE_MAX_CHARS)
}

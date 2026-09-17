/** 智能体对话协议（`/api/agent/*`）。一轮的事件流走 `text/event-stream`。 */

import type { ChannelMedia } from './channel-discovery'
import type { StoredImageRef } from './queue-protocol'

/**
 * 匿名设备标识的传输位置。它是纯 bearer——知道就等于持有，所以只走请求头或请求体：
 * query string 会落进访问日志、代理日志、浏览器历史和 Referer。
 */
export const DEVICE_ID_HEADER = 'x-device-id'

export const AGENT_CONVERSATION_TITLE_MAX_CHARS = 60
export const AGENT_USER_MESSAGE_MAX_CHARS = 4_000

export type AgentMessageRole = 'user' | 'assistant'

export interface AgentTextBlock {
  readonly type: 'text'
  readonly text: string
  /** 用户消息的参考图快照；字节存对象存储，跨轮与重开会话仍可用。 */
  readonly references?: readonly AgentStoredReference[]
}

/**
 * 这一轮要创作什么。它决定模型收到哪些工具、系统提示词里列哪些技能，
 * 不决定历史怎么渲染——旧轮的工具结果在任何创作类型下都照样认得出来。
 * 请求里缺席即 `image`：老客户端不知道有这回事。
 */
export type AgentMode = 'image' | 'video'

export const AGENT_MODES: readonly AgentMode[] = ['image', 'video']

export function isAgentMode(value: unknown): value is AgentMode {
  return value === 'image' || value === 'video'
}

/** 智能体可调用的工具。 */
export type AgentToolName =
  | 'generateImage'
  | 'editImage'
  | 'readLibrary'
  | 'generateVideo'
  | 'loadSkill'

/**
 * 技能没写 `meta.json`、或写坏了时用的图标。技能不会因此被丢掉，只是长得一样。
 * 前端的白名单映射表必须收着它，否则回退还得再回退一次。
 */
export const DEFAULT_AGENT_SKILL_ICON = 'sparkles'

/**
 * 技能清单端点给前端的那一份：标识、标题、「何时用」，外加界面用的图标与一句话简介。
 * `name` 是 Agent Skills 标准的 kebab-case 标识，服务端只认它；`title` 是给人看的那个名字。
 *
 * `icon` / `summary` 来自技能目录里的 `meta.json`，**只走界面**：它们不进系统提示词、
 * 不进任何给模型的文本（见 `apps/bff/src/lib/agent/turn-input.ts` 的 `<available_skills>`）。
 */
export interface AgentSkillSummary {
  readonly name: string
  readonly title: string
  readonly description: string
  /** lucide 图标名，kebab-case。前端按白名单映射成组件，不认识的名字回退默认图标。 */
  readonly icon: string
  /** 写给用户的一句话简介；空串表示这条技能没写，界面回退到去掉「何时用：」的 description。 */
  readonly summary: string
}

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

export interface AgentStoredReference {
  readonly imageId: string
  readonly name?: string
  readonly image: StoredImageRef
  readonly mask?: StoredImageRef
}

/**
 * 一轮里生效的生成参数：用户在输入框的参数浮层里选，随起轮一起送到服务端，
 * 生图与改图工具提交队列任务时按它填。张数由每次工具调用决定，审核使用应用默认。
 *
 * 字段名对齐 `SubmitRequest`，避免在途中翻译两次；但 `gemini_*` 三项保持前缀，
 * 因为它们只对 gemini 系模型成立，往队列请求里填哪一支由服务端按 provider 决定。
 */
export type AgentThinkingDepth = 'fast' | 'medium' | 'deep'

export interface AgentTurnParams {
  readonly thinkingDepth?: AgentThinkingDepth
  /** 生成模型。解析不出来（模型下线、介质不符）就退回部署配置的那一个。 */
  readonly model?: string
  readonly size?: string
  readonly quality?: string
  readonly output_format?: string
  readonly output_compression?: number
  readonly gemini_aspect_ratio?: string
  readonly gemini_image_size?: string
  readonly gemini_thinking_level?: string
}

/** 图片工具单次调用的产出上限；模型参数与画布占位共用。 */
export const AGENT_IMAGE_MAX_N = 10

export const AGENT_TURN_MAX_REFERENCES = 8

export type AgentToolStatus = 'succeeded' | 'failed'

/**
 * 工具产出的一件产物。`artifactId` 同时是画布对象的 id，结果卡凭它定位到画布上同一个对象。
 * `media` 是取字节的判据：图片下载成位图，视频只拿播放地址。
 */
export interface AgentToolArtifact {
  readonly artifactId: string
  readonly media: ChannelMedia
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
  /** 完整生成提示词，标题仅用于摘要。旧记录可能缺席。 */
  readonly prompt?: string
  readonly artifacts?: readonly AgentToolArtifact[]
  /** 产出落画布时贴着这个画布对象放；缺席就落在视口中央。 */
  readonly anchorObjectId?: string
  /** 读取技能这一步的结果。缺席即这条不是读技能，或者它还没跑完。 */
  readonly skill?: AgentSkillOutcome
  /** 失败原因，一句话。 */
  readonly message?: string
}

/**
 * 读取技能读到了什么。`found` 是机器可读的那一位：面板据它决定这一行说「读取技能」还是
 * 「没找到技能」，不靠匹配工具返回的文案。
 */
export interface AgentSkillOutcome {
  readonly label: string
  readonly found: boolean
  /**
   * 这条技能的图标名，与 `/` 菜单用同一张白名单映射表。老消息里没有这一位（这个字段是后加的），
   * 没找到技能的那次也没有——两种情况界面都退回默认图标。
   */
  readonly icon?: string
}

/** 一次澄清提问。落在助手消息里，所以重新打开会话还能看见、还能作答。 */
export interface AgentClarificationBlock {
  readonly type: 'clarification'
  readonly question: string
  readonly options: readonly string[]
}

export type AgentContentBlock = AgentTextBlock | AgentToolResultBlock | AgentClarificationBlock

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

/** 一轮的消耗明细，单位是积分。 */
export interface AgentTurnCost {
  readonly chat: number
  readonly image: number
  readonly video: number
}

export function agentTurnCostTotal(cost: AgentTurnCost): number {
  return cost.chat + cost.image + cost.video
}

export interface AgentTurnStartEvent {
  readonly type: 'turnStart'
  readonly turnId: string
  readonly userMessageId: string
  /** 本轮预扣的积分；不计费的部署里缺席。 */
  readonly reservedCredits?: number
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

/**
 * 一次工具调用开始。`messageId` 是这次调用独占的助手消息，工具的三个事件都指向它。
 * 后两项让画布在工具还没跑完时就能占好位：知道占几个、占在哪。
 */
export interface AgentToolStartEvent {
  readonly type: 'toolStart'
  readonly messageId: string
  readonly toolCallId: string
  readonly toolName: AgentToolName
  readonly title: string
  /** 完整生成提示词，标题仅用于摘要。旧记录可能缺席。 */
  readonly prompt?: string
  /** 这次调用会落几件产物；缺席即这个工具不落画布（查素材库），画布不必占位。 */
  readonly outputCount?: number
  /** 占位框贴着这个画布对象放；缺席就落在视口中央。与结果里的 `anchorObjectId` 同源。 */
  readonly anchorObjectId?: string
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

export type AgentClarificationEvent = AgentClarificationBlock & {
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
  /** Total input, including the separately reported cached portion. */
  readonly inputTokens: number
  readonly cachedInputTokens?: number
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
  /** 结算后的实际消耗；不计费的部署里缺席。失败与中止的轮全是 0。 */
  readonly cost?: AgentTurnCost
}

export type AgentTurnEvent =
  | AgentTurnStartEvent
  | AgentAssistantStartEvent
  | AgentTextDeltaEvent
  | AgentToolStartEvent
  | AgentToolProgressEvent
  | AgentToolEndEvent
  | AgentClarificationEvent
  | AgentInterjectionEvent
  | AgentTurnEndEvent

/** 翻历史时每轮页脚要的那几项。 */
export interface AgentTurnSummaryView {
  readonly turnId: string
  readonly durationMs: number
  readonly stopReason: AgentTurnStopReason
  readonly cost?: AgentTurnCost
}

/** 进行中的轮，`GET .../messages` 用它告诉刷新后的前端该挂回哪一轮。 */
export interface AgentActiveTurnView {
  readonly turnId: string
}

/**
 * 起轮撞上同会话已经在跑的那一轮时的 409 响应体。带着轮标识，客户端据此转去续播——
 * 两个标签页开着同一个会话时，后发的那个看到的是那一轮接着流，而不是一个错误。
 */
export interface AgentTurnAlreadyRunningBody {
  readonly error: 'turn_already_running'
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

/** 说给模型听的产物名词。工具的结果文字与回放共用，两处不一致模型就指不准同一件东西。 */
export const AGENT_ARTIFACT_NOUN: Record<ChannelMedia, string> = { image: '图片', video: '视频' }

/** 工具结果回放给模型的形状：产物 id 让它下一轮还能指着同一件东西说话。 */
export function agentToolResultSummary(block: AgentToolResultBlock): string {
  if (block.status === 'failed') return `${block.title}：失败（${block.message ?? '未知原因'}）`
  const listed = (block.artifacts ?? [])
    .map((artifact) => `${AGENT_ARTIFACT_NOUN[artifact.media]} ${artifact.artifactId}`)
    .join(', ')
  return listed ? `${block.title}：完成，${listed}` : `${block.title}：完成`
}

/** 澄清回放给模型的形状：用户的下一条消息就是他选的那一项。 */
export function agentClarificationSummary(block: AgentClarificationBlock): string {
  return `向用户提问：${block.question}（选项：${block.options.join(' / ')}）`
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

import type { TaskProgressPhase } from '../queue-protocol'
import type { AgentClarificationBlock, AgentMessageView, AgentTurnCost } from './messages'
import type {
  AgentSaveCardKind,
  AgentToolCallSnapshot,
  AgentToolErrorCode,
  AgentToolName,
  AgentToolResultBlock,
  AgentToolStage,
} from './tools'
import type { AgentTurnReference } from './turn-params'

/**
 * `POST .../saves`：用户按下了保存，记录已经落在本机。服务端据此把卡片就地改写成已保存，
 * 并往收件箱里放一条「已保存」的用户消息，智能体下一轮接着往下说。
 *
 * 按 `toolCallId` 认卡（一条消息只装一个结果块），重复提交是幂等的：同一张卡只改写一次、
 * 只排一条消息。
 */
export interface AgentSaveRequest {
  readonly toolCallId: string
  readonly kind: AgentSaveCardKind
  /** 本机记录的 id。它是本机的东西，服务端只当标识转述给模型，不据它读任何内容。 */
  readonly recordId: string
  /** 用户在卡上最后定下的名字：模型拟的那个可能被他改过。 */
  readonly name: string
}

/** 保存之后那张卡此刻的样子（就地改写，消息 id 不变）。 */
export interface AgentSaveResponse {
  readonly message: AgentMessageView
}

/** `POST .../retries` 成功时的响应：追加在对话末尾的那条重试记录。 */
export interface AgentRetryResponse {
  readonly message: AgentMessageView
}

/** 重试没能提交（模型已下线、积分不够、没登录……）时的响应体；界面只按 `code` 给出路。 */
export interface AgentRetryRefusedBody {
  readonly error: 'retry_refused'
  readonly code: AgentToolErrorCode
}

/**
 * 用户确认一张待确认的生成卡：提示词按他最后看到、最后改过的那一份原样提交，服务端不再经过
 * 模型重写。会话与卡的归属由端点确权，`messageId` 就是那张卡的消息 id。
 */
export interface AgentConfirmationRequest {
  readonly draftRevision?: number
  readonly deviceId: string
  readonly messageId: string
  readonly prompt: string
}

/** 确认能提交多长的提示词。超过即拒收：上游会截断，用户看到的和真正生成的就对不上了。 */
export const AGENT_CONFIRMATION_PROMPT_MAX_CHARS = 8_000

/**
 * `POST .../confirmations` 成功时的响应：那张卡此刻的样子（就地改写，消息 id 不变）。
 * 重复确认（双击、另一个标签页、网络重发）拿到的是同一张已提交的卡，不会提交第二次。
 */
export interface AgentConfirmationResponse {
  readonly message: AgentMessageView
  /**
   * 确认门拦下的那一轮会接着跑（这一轮被拦下的卡都确认完了）：界面去跟进那一轮的流，
   * 它接在原来那段回复后面。缺席即这张卡不是确认门的卡，或同一轮还有没确认的卡。
   */
  readonly continued?: true
}

/** 确认没能提交（积分不够、模型下线、提示词为空或过长……）；界面只按 `code` 给出路。 */
export interface AgentConfirmationRefusedBody {
  readonly error: 'confirmation_refused'
  readonly code: AgentToolErrorCode
}

/** `GET .../jobs` 里的一项：一次提交了后台任务的工具调用，结果块是它此刻的样子。 */
export interface AgentBackgroundJobView {
  /** 那张结果卡的消息 id。 */
  readonly messageId: string
  readonly turnId: string
  readonly result: AgentToolResultBlock
  /** 任务还没结束时它此刻走到哪一步；结果块已是终局时缺席。 */
  readonly progress?: AgentBackgroundJobProgress
}

/**
 * 没结束的后台任务此刻的进度，取自任务表：`submitted` 是排着队，`running` 是在生成。
 * 已用时间从 `submittedAt`（任务受理时刻，epoch 毫秒）算起，所以刷新、换设备后看到的是同一个数。
 */
export interface AgentBackgroundJobProgress {
  readonly stage: AgentToolStage
  readonly submittedAt: number
  /**
   * 任务表里的持久阶段（ADR 0009）：执行器在滚动发布或重启后重新接上上游时是 `reconnecting`，
   * 结果已归档、正在确认时是 `confirming`。旧服务端缺席，这时按 `stage` 读。
   */
  readonly phase?: TaskProgressPhase
  /**
   * 当前阶段开始的时刻。结果确认用它判断是否已经超过 30 分钟；
   * 其他阶段缺席，已用时间仍从 `submittedAt` 算。
   */
  readonly phaseSince?: number
  /**
   * 还在排队时它在本账号队列里的位置。账号同时生成的张数由套餐定（没订阅是 1），
   * 超出的按提交先后排队：`ahead` 是排在它前面、还没出完的张数（在生成的加上更早提交的），
   * `limit` 是此刻这个账号能同时生成几张。旧服务端缺席，界面只说「排队中」。
   */
  readonly queue?: AgentJobQueuePosition
}

export interface AgentJobQueuePosition {
  readonly ahead: number
  readonly limit: number
}

export interface AgentBackgroundJobsResponse {
  readonly jobs: readonly AgentBackgroundJobView[]
}

/** `POST .../jobs/:taskId/cancel` 的回应：取消之后这次调用此刻的样子（已结束的任务原样返回）。 */
export interface AgentBackgroundJobCancelResponse {
  readonly job: AgentBackgroundJobView
}

export interface AgentTurnStartEvent {
  readonly type: 'turnStart'
  readonly turnId: string
  readonly userMessageId: string
  /** 本轮预扣的积分；不计费的部署里缺席。 */
  readonly reservedCredits?: number
  /**
   * 这一轮是唤醒：后台任务结束后智能体回来看结果，或者中断续跑（上一轮被服务重启打断后接着做），
   * 不是用户说了话。`userMessageId` 此时不指向任何一条消息，界面不为它出用户气泡。
   */
  readonly wake?: true
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
  /** 起跑这一刻的参数快照，与结果块里的是同一份。 */
  readonly snapshot?: AgentToolCallSnapshot
  /**
   * 服务端看到工具起跑的时刻（epoch 毫秒）。它随事件落进轮的事件日志，续播、刷新、换设备
   * 重放出来的是同一个数，已用时间因此不从零重来。旧记录缺席。
   */
  readonly startedAt?: number
}

/** 分钟级任务的中途进度。一轮里可以有多次工具调用，各自按 `toolCallId` 独立上报。 */
export interface AgentToolProgressEvent {
  readonly type: 'toolProgress'
  readonly messageId: string
  readonly toolCallId: string
  readonly stage: AgentToolStage
}

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

/**
 * 排队消息：智能体忙时用户发出、存在服务端会话收件箱里、还没被处理的那条话。
 * 当前回复可以结束时按顺序取，每轮取一条。只给界面看的那几项，参考图字节不下发。
 */
export interface AgentQueuedMessageView {
  /** 收件箱记录 id；被处理后它就是那条用户消息的 id。 */
  readonly id: string
  /** 客户端生成的消息 id，同一条消息网络重发时据此认出来，不排第二次。 */
  readonly clientMessageId: string
  readonly text: string
  /** 附带了几张参考图。 */
  readonly referenceCount: number
  readonly createdAt: number
  /**
   * 轮到它时没能开轮的原因（错误码，界面据此选文案）。带着它的这一条不再排着、也不挡后面的，
   * 留在列表里等用户看过后撤掉。缺席即仍在排队。
   */
  readonly failure?: AgentQueuedMessageFailure
  /**
   * 这是对澄清卡片的答复：它排在其他排队消息前面，智能体停下来等的问题最先得到回答。
   * 缺席即普通的排队消息。
   */
  readonly clarificationAnswer?: true
}

/** 排队消息轮到时开不了轮的原因：余额不足、额度用完、访问被拒、模型没有定价、需要登录。 */
export type AgentQueuedMessageFailure =
  | 'insufficient_credits'
  | 'quota_exceeded'
  | 'access_denied'
  | 'model_price_unavailable'
  | 'unauthorized'

/** 每个会话最多同时排着这么多条用户消息；再发就拒收并提示。 */
export const AGENT_QUEUE_MAX_PENDING = 10

/** 收件箱记录此刻的状态：待处理、已被某一轮消费、已撤回、轮到时没能开轮。 */
export type AgentQueuedMessageState = 'pending' | 'consumed' | 'cancelled' | 'failed'

/**
 * 撤回排队消息的结局，三者只有一个成立：撤回成功（再撤一次也还是它）、已经被一轮处理了、
 * 没有这条。撤回与处理由同一条记录上的原子更新裁决，跨设备并发也不会两边都算数。
 */
export type AgentQueueWithdrawResult = 'cancelled' | 'already_consumed' | 'not_found'

/**
 * 发消息被收进收件箱时的 202 响应体。会话空闲、这条消息当场开了一轮时不走它，直接回事件流。
 * `turnId`：`pending` 时是正在跑的那一轮，`consumed` 时是处理了它的那一轮。
 */
export interface AgentMessageQueuedBody {
  readonly queued: AgentQueuedMessageView
  readonly state: AgentQueuedMessageState
  readonly turnId?: string
}

/**
 * 把排队消息升级为插话的结局：插进了正在跑的那一轮（在它下一个动作边界生效）；已经被处理了；
 * 已撤回；没有这条；会话此刻没有在跑的轮（它照旧排着，下一轮处理）。
 */
export type AgentQueueInterjectResult =
  | 'interjected'
  | 'already_consumed'
  | 'cancelled'
  | 'not_found'
  | 'not_running'

/** 停止当前回复时退回给客户端的一条排队消息：放回输入框，由用户改了再发或删掉。 */
export interface AgentReturnedQueuedMessage {
  readonly id: string
  readonly text: string
  /** 它当初附带的参考图，原样还回去。 */
  readonly references: readonly AgentTurnReference[]
}

/** 停止当前回复的响应体。`returned` 是被退回的排队消息，按原先的处理顺序；老服务端没有这一项。 */
export interface AgentTurnAbortedBody {
  readonly aborted: true
  readonly returned?: readonly AgentReturnedQueuedMessage[]
  /**
   * 随这次停止一并取消、积分已退回的出图任务（这一轮自己提交、还没出结果的）。已完成的照常扣费，
   * 不在其中；中止之后才落库的那几条由轮收尾再取消，也不在其中——任务卡照常轮询到「已取消」。
   * 老服务端没有这一项。
   */
  readonly cancelledTaskIds?: readonly string[]
}

/** 满额时的 409 响应体。 */
export interface AgentQueueFullBody {
  readonly error: 'queue_full'
  readonly limit: number
}

/** 有一条消息排进了队。 */
export interface AgentMessageQueuedEvent {
  readonly type: 'messageQueued'
  readonly message: AgentQueuedMessageView
}

/** 一条排队消息被撤回了。 */
export interface AgentQueuedMessageWithdrawnEvent {
  readonly type: 'queuedMessageWithdrawn'
  readonly queueId: string
}

/** 一条排队消息升级成了插话，进了正在跑的这一轮；随后的 `interjection` 事件带着它的正文。 */
export interface AgentQueuedMessageInterjectedEvent {
  readonly type: 'queuedMessageInterjected'
  readonly queueId: string
  readonly turnId: string
}

/** 一条排队消息被这一轮取走处理；它紧跟在那一轮的 `turnStart` 之后。 */
export interface AgentQueuedMessageConsumedEvent {
  readonly type: 'queuedMessageConsumed'
  readonly queueId: string
  readonly turnId: string
}

/** 上游按 `stream_options.include_usage` 在末帧回的用量。中转网关不透传时是 null。 */
export interface AgentTurnUsage {
  /** Total input, including the separately reported cached portion. */
  readonly inputTokens: number
  readonly cachedInputTokens?: number
  readonly outputTokens: number
}

export type AgentTurnStopReason = 'completed' | 'aborted' | 'failed'

/**
 * `agent_turn_interrupted`：这一轮被服务重启或执行者接管打断，已经排上了一次中断续跑——界面不把它
 * 当失败报，只标明「已中断，自动续上」。
 * `agent_context_overflow`：这一份请求算出来就超过输入预算，服务端没有发它。不是跑挂了，
 * 是明确停在这里——回退成发更完整的历史只会更超（见 BFF 的 `request-budget.ts`）。
 * 其余几个是真的失败。
 */
export type AgentTurnErrorCode =
  | 'agent_upstream_error'
  | 'agent_run_failed'
  | 'agent_tool_failed'
  | 'agent_turn_interrupted'
  | 'agent_context_overflow'
  | 'agent_request_budget_exceeded'

/** 失败诊断只保留错误文本与调用标识，不包含请求内容或认证信息。 */
export interface AgentTurnFailure {
  readonly code: AgentTurnErrorCode
  readonly message: string
  readonly model?: string
  readonly requestId?: string
  readonly occurredAt: string
}

/** 轮唯一的终帧。续播读到它就收流，不必再问轮是否还活着。 */
export interface AgentTurnEndEvent {
  readonly type: 'turnEnd'
  readonly turnId: string
  readonly durationMs: number
  readonly stopReason: AgentTurnStopReason
  readonly error?: AgentTurnErrorCode
  readonly failure?: AgentTurnFailure
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
  | AgentMessageQueuedEvent
  | AgentQueuedMessageWithdrawnEvent
  | AgentQueuedMessageConsumedEvent
  | AgentQueuedMessageInterjectedEvent
  | AgentTurnEndEvent

/** 翻历史时每轮页脚要的那几项。 */
export interface AgentTurnSummaryView {
  readonly turnId: string
  readonly durationMs: number
  readonly stopReason: AgentTurnStopReason
  /** 只在失败的轮上：被打断并排上了中断续跑时是 `agent_turn_interrupted`，其余缺席。 */
  readonly error?: AgentTurnErrorCode
  readonly failure?: AgentTurnFailure
  readonly cost?: AgentTurnCost
  /** 建议用户接着发的完整句子。缺席表示这一轮没有。 */
  readonly followUps?: readonly string[]
}

/** 进行中的轮，`GET .../messages` 用它告诉刷新后的前端该挂回哪一轮。 */
export interface AgentActiveTurnView {
  readonly turnId: string
}

/**
 * `GET .../messages` 的响应：会话快照。`cursor` 是快照覆盖到的会话事件序号，客户端从它之后
 * 接增量（`GET .../events` 带 `Last-Event-ID`），快照与增量之间不重不漏。有进行中的轮时，
 * 游标停在那一轮的 `turnStart` 之前：还没落库的半截回复只在事件里，得从轮头重放出来。
 * 老服务端不回 `cursor`，客户端据此退回按轮续播。
 */
export interface AgentConversationSnapshot {
  readonly messages: readonly AgentMessageView[]
  readonly turns: readonly AgentTurnSummaryView[]
  readonly activeTurn: AgentActiveTurnView | null
  readonly cursor?: number
  /** 按处理顺序排着的消息，连同轮到时没能开轮、还没撤掉的那几条（带 `failure`）；老服务端没有这一项。 */
  readonly queue?: readonly AgentQueuedMessageView[]
  /** 还有更早的历史消息时给出当前页最旧一条的序号，传 `?beforeSeq=` 向前翻页；null 表示已到开头。 */
  readonly nextBeforeSeq?: number | null
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

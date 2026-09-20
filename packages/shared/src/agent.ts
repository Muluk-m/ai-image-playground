/** 智能体对话协议（`/api/agent/*`）。一轮的事件流走 `text/event-stream`。 */

import type { ChannelMedia } from './channel-discovery'
import type { StoredImageRef, TaskProgressPhase } from './queue-protocol'
import type { VideoGenerationRecord } from './video-generation'

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
  | 'viewImage'
  | 'readLibrary'
  | 'generateVideo'
  | 'loadSkill'
  | 'arrangeTimeline'

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
  /**
   * 出图模式：生成工具拟好稿就当场提交，不再停在「等待确认」等用户逐张点。
   *
   * 它换掉的是用户那道花钱闸门，所以只认显式的 `true`：缺席、`false` 都是对话模式。
   * 一轮最多自动提交 {@link AGENT_AUTO_SUBMIT_MAX_PER_TURN} 次，超出的照常退回等待确认。
   */
  readonly autoSubmit?: true
  readonly size?: string
  readonly quality?: string
  readonly output_format?: string
  readonly output_compression?: number
  readonly gemini_aspect_ratio?: string
  readonly gemini_image_size?: string
  readonly gemini_thinking_level?: string
}

/**
 * 出图模式下一轮最多自动提交多少次生成。
 *
 * 对话模式靠「拟稿即收尾」刹车：一拟稿这一轮就结束，模型没机会接着调。出图模式要的正是
 * 连着出，那条刹车就没了，剩下的只有模型自己。超过这个数之后的调用退回等待确认——
 * 不报错、不中断，用户仍然看得见那些稿，只是要自己点。
 */
export const AGENT_AUTO_SUBMIT_MAX_PER_TURN = 12

/** 图片工具单次调用的产出上限；模型参数与画布占位共用。 */
export const AGENT_IMAGE_MAX_N = 10

/**
 * 这次图片工具调用出几张。画布占位与队列请求的 `n` 共用这一个算式——两处算出的数不一样，
 * 占位框就会和真正出的张数对不上。语义与 `Type.Integer` 的 `Value.Convert` 一致：
 * 数字串按数字读，小数截断，读不出整数一律算一张，最后收口到 1..`AGENT_IMAGE_MAX_N`。
 */
export function agentImageCount(args: { readonly n?: unknown } | null | undefined): number {
  const raw = typeof args?.n === 'string' ? Number(args.n) : args?.n
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 1
  return Math.min(AGENT_IMAGE_MAX_N, Math.max(1, Math.trunc(raw)))
}

export const AGENT_TURN_MAX_REFERENCES = 8

/**
 * 一次工具调用的结局。生成工具先停在 `awaiting_confirmation`，提示词经用户确认后才会提交后台任务。
 * `submitted` 是后台任务刚提交、结果尚未就绪：任务结束后服务端把它就地改写成 `succeeded` 或
 * `failed`（见 {@link AgentBackgroundJob}）。`queued` 只出现在重试记录上。
 */
export type AgentToolStatus =
  | 'succeeded'
  | 'failed'
  | 'submitted'
  | 'queued'
  | 'awaiting_confirmation'

/**
 * 一次工具调用为什么失败。界面只按它决定给什么出路（ADR 0006），不读 `message`：
 *
 * - `upstream_error` / `timeout` / `no_output`：上游那一侧没出来，原样再跑一次有望成功。
 * - `result_unknown`：执行者中途丢了，或上游的结局查不到；上游可能已经出图、已经计费，
 *   不能原样重试（ADR 0009），不给出路。
 * - `insufficient_credits` / `quota_exceeded`：钱或额度不够，出路是充值。
 * - `authentication_required`：没登录，出路是登录。
 * - `invalid_params`：模型给的参数本身不成立（图片 id 不存在、违反选区约束、张数越界），
 *   出路是让智能体换个做法重新处理。
 * - `model_unavailable`：当时要用的模型已下线或没有可用模型，同样交给智能体。
 * - `cancelled`：用户中止了这一轮，不需要出路。
 * - `unknown`：归不进上面任何一类。
 *
 * 旧记录没有这一位；前端认不出的码也按没有处理。
 */
export type AgentToolErrorCode =
  | 'upstream_error'
  | 'timeout'
  | 'no_output'
  | 'result_unknown'
  | 'insufficient_credits'
  | 'quota_exceeded'
  | 'authentication_required'
  | 'invalid_params'
  | 'model_unavailable'
  | 'cancelled'
  | 'unknown'

export const AGENT_TOOL_ERROR_CODES: readonly AgentToolErrorCode[] = [
  'upstream_error',
  'timeout',
  'no_output',
  'result_unknown',
  'insufficient_credits',
  'quota_exceeded',
  'authentication_required',
  'invalid_params',
  'model_unavailable',
  'cancelled',
  'unknown',
]

export function isAgentToolErrorCode(value: unknown): value is AgentToolErrorCode {
  return AGENT_TOOL_ERROR_CODES.includes(value as AgentToolErrorCode)
}

/**
 * 工具起跑那一刻模型选定的全部参数，失败记录与重试都从这里取，不再回头问模型。
 * 旧记录没有它：那些失败没有可复原的参数。
 */
export interface AgentToolCallSnapshot {
  /** 这一轮的创作类型；同一个工具在两种类型下装配的清单不同。 */
  readonly mode: AgentMode
  /** 模型给的参数，按工具 schema 换算后的原样：提示词、张数、选区绑定、档位都在这里。 */
  readonly args: Readonly<Record<string, unknown>>
  /** 参数里引用的图（可能写成 `image 2` 这类编号）翻成的真实图片 id，顺序与参数一致。 */
  readonly imageIds?: readonly string[]
  /** 这一轮用户在参数浮层里选的生成参数（尺寸、质量等）。 */
  readonly params?: AgentTurnParams
  /** 起跑时解析到的生成模型；缺席即当时没有可用模型。 */
  readonly target?: { readonly provider: string; readonly model: string }
}

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
  /** 视频产物实际提交的参数。早于它的记录没有；图片产物永远没有。 */
  readonly video?: VideoGenerationRecord
}

/**
 * 智能体排好的一条时间线：按顺序引用本会话落画布的视频产物（产物 id 即画布对象 id），带每段入出点（秒）。
 * 画布按它建一条时间线元素，id 用 `timelineId`，所以重放不会建出第二条。
 */
export interface AgentTimelinePlan {
  readonly timelineId: string
  readonly clips: readonly AgentTimelineClip[]
}

/** 时间线上的一段：哪段视频、从第几秒播到第几秒。出点总在入点之后。 */
export interface AgentTimelineClip {
  readonly videoId: string
  readonly in: number
  readonly out: number
}

/**
 * 工具提交的后台任务：提交后立即交还对话，任务结束后产物按产物交付落画布。
 * 结果块带着它，任务结束时服务端据此把块改写成终局；旧记录与不提交后台任务的调用缺席。
 */
export interface AgentBackgroundJob {
  readonly taskId: string
  readonly media: ChannelMedia
  /** 视频任务实际提交的档位；任务成功时记到产物上。 */
  readonly video?: VideoGenerationRecord
  /**
   * 智能体提交时要求成功后回来复核（局部改图总是要）。失败一律唤醒，与它无关；界面据此知道
   * 任务结束后会不会有一轮唤醒要挂上。
   */
  readonly review?: true
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
  /** 失败原因，一句话。给日志与模型看，界面按 `errorCode` 出文案。 */
  readonly message?: string
  /** 失败的分类；只在 `status: 'failed'` 时有。旧记录缺席。 */
  readonly errorCode?: AgentToolErrorCode
  /** 起跑时的参数快照；只有提交生成任务的工具有。旧记录缺席。 */
  readonly snapshot?: AgentToolCallSnapshot
  /** 这次调用提交的后台任务；任务结束后仍保留，标明这张卡的结局来自后台任务。 */
  readonly job?: AgentBackgroundJob
  /** 这张卡是一条重试记录：用户在哪张失败卡的哪个失败占位上点了重试。普通调用缺席。 */
  readonly retryOf?: AgentToolRetryOrigin
  /**
   * 这个后台任务结束后本该唤醒智能体，但没有唤醒：面板按原因说明智能体没有查看这个结果。
   * 结果照常落画布，用户下次说话时智能体在对话记录里看得到它。缺席即唤醒过或本就不唤醒。
   */
  readonly wakeSkipped?: AgentWakeSkipReason
  /** 排时间线这一步的结果：画布照它建时间线。缺席即这条不是排时间线，或者没有可排的视频。 */
  readonly timeline?: AgentTimelinePlan
}

/**
 * 没有唤醒智能体的原因：积分不足以再起一轮；用户没说话时已经连续自动唤醒了
 * {@link AGENT_MAX_CONSECUTIVE_WAKES} 次。
 */
export type AgentWakeSkipReason = 'insufficient_credits' | 'wake_limit'

/** 用户没说话时最多连续自动唤醒这么多次，之后停下等用户；用户一说话就重新计数。 */
export const AGENT_MAX_CONSECUTIVE_WAKES = 3

/**
 * 重试记录指回的那次失败调用。重试不改写原卡：原卡保持失败，重试另起一条记录挂在对话末尾，
 * 凭它跳回原卡、把结果落回原来的失败占位。
 */
export interface AgentToolRetryOrigin {
  /** 原失败卡的消息 id。 */
  readonly messageId: string
  readonly toolCallId: string
  /** 结果要落回的那个失败占位（画布对象 id）；缺席即就近落。 */
  readonly placeholderId?: string
}

/** 原样再跑一次有望成功的那几类失败（上游出错、超时、没出图）。 */
export const AGENT_RETRYABLE_ERROR_CODES: readonly AgentToolErrorCode[] = [
  'upstream_error',
  'timeout',
  'no_output',
]

/** 能按快照原样重出的工具。查素材库、看图、读技能不提交生成任务，没有可重出的东西。 */
const RETRYABLE_TOOLS: readonly AgentToolName[] = ['generateImage', 'editImage', 'generateVideo']

/**
 * 局部改图（选区绑定、分方案摘录）与连锁改图（列了后续步骤、或是后续步骤本身）的参数离不开
 * 那一轮的上下文：原样重出可能改错地方，只能交给智能体重新处理。
 * 没有快照就谈不上这件事，那是「认不出这次调用」，另有判据。
 */
export function agentToolLocalEdit(snapshot: AgentToolCallSnapshot | undefined): boolean {
  if (!snapshot) return false
  const { selectionBindings, requestQuote, deferredEdits } = snapshot.args
  return (
    (Array.isArray(selectionBindings) && selectionBindings.length > 0) ||
    (typeof requestQuote === 'string' && requestQuote.length > 0) ||
    (Array.isArray(deferredEdits) && deferredEdits.length > 0)
  )
}

/** 判定重试资格要看的那几位：服务端的结果块与前端的结果卡都有。 */
export interface AgentRetryCandidate {
  readonly status: string
  readonly toolName?: AgentToolName
  readonly errorCode?: AgentToolErrorCode
  readonly snapshot?: AgentToolCallSnapshot
  readonly job?: AgentBackgroundJob
  readonly retryOf?: AgentToolRetryOrigin
}

/**
 * 这次失败认不认得出是「一次真的跑过的生成」：生成工具、起跑记了参数快照与模型、提交过
 * 后台任务、自己不是重试记录。认得出才谈得上重出，也才谈得上请智能体照着重新处理——
 * 认不出的（旧记录没有快照、查素材库这类不出图的调用）两件事都做不了。
 */
export function agentToolRerunnable(block: AgentRetryCandidate): boolean {
  return (
    block.status === 'failed' &&
    block.toolName !== undefined &&
    RETRYABLE_TOOLS.includes(block.toolName) &&
    block.snapshot?.target !== undefined &&
    block.job !== undefined &&
    block.retryOf === undefined
  )
}

/**
 * 这张失败卡能不能原样重试。只看结构化的几位，不读文字（ADR 0006）：认得出是一次跑过的
 * 生成、错误码可重试、不是局部或连锁改图。局部与连锁改图留在轮里同步等结果，从来不带
 * `job`，所以 `agentToolRerunnable` 也已经把它们挡在门外。
 * 模型是否已下线要问此刻的模型清单，由调用方另判。
 */
export function agentToolRetryable(block: AgentRetryCandidate): boolean {
  return (
    agentToolRerunnable(block) &&
    block.errorCode !== undefined &&
    AGENT_RETRYABLE_ERROR_CODES.includes(block.errorCode) &&
    !agentToolLocalEdit(block.snapshot)
  )
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
}

export interface AgentBackgroundJobsResponse {
  readonly jobs: readonly AgentBackgroundJobView[]
}

/** `POST .../jobs/:taskId/cancel` 的回应：取消之后这次调用此刻的样子（已结束的任务原样返回）。 */
export interface AgentBackgroundJobCancelResponse {
  readonly job: AgentBackgroundJobView
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

/** 排队消息轮到时开不了轮的原因：余额不足、模型没有定价、需要登录。 */
export type AgentQueuedMessageFailure =
  | 'insufficient_credits'
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
 * 当失败报，只标明「已中断，自动续上」。其余几个是真的失败。
 */
export type AgentTurnErrorCode =
  | 'agent_upstream_error'
  | 'agent_run_failed'
  | 'agent_tool_failed'
  | 'agent_turn_interrupted'

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
  readonly cost?: AgentTurnCost
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

/**
 * 工具结果回放给模型的形状：产物 id 让它下一轮还能指着同一件东西说话。
 *
 * 已提交与已完成的生成卡带上真正执行的那句提示词：它是用户在确认卡上最后定下的指令，可能与他
 * 更早的原话不一致（他改掉了模型自作主张的颜色、补了一句约束）。复核与后续几轮都要按这一句判断，
 * 所以它必须出现在回放里，而不只是留在卡面上。
 */
export function agentToolResultSummary(block: AgentToolResultBlock): string {
  // 重试是用户自己点的：模型据此知道那张失败的图已经补上（或又失败了），不必再提议重做。
  const title = block.retryOf ? `用户重试了「${block.title}」` : block.title
  if (block.status === 'awaiting_confirmation')
    return `${title}：提示词待用户确认，尚未提交生成任务`
  const executed =
    block.job && block.prompt ? `；执行提示词（用户确认的那一份）：${block.prompt}` : ''
  if (block.status === 'failed')
    return `${title}：失败（${block.message ?? '未知原因'}）${executed}`
  if (block.status === 'submitted') return `${title}：已提交后台任务，结果尚未就绪${executed}`
  if (block.status === 'queued') return `${title}：排队等待重试，尚未提交`
  const listed = (block.artifacts ?? [])
    .map((artifact) => `${AGENT_ARTIFACT_NOUN[artifact.media]} ${artifact.artifactId}`)
    .join(', ')
  return `${title}：${listed ? `完成，${listed}` : '完成'}${executed}`
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

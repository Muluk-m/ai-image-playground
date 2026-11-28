import type { AgentBatchAnalysisLimit } from '../agent-batch'
import type { StoryboardStageSummary } from '../canvas-storyboard'
import type { ChannelMedia } from '../channel-discovery'
import type { TaskErrorType } from '../queue-protocol'
import type {
  ASSET_BACKGROUNDS,
  ASSET_KINDS,
  ASSET_VIEW_LABELS,
  ASSET_VIEW_SOURCES,
} from '../sync-protocol'
import type { VideoGenerationRecord } from '../video-generation'
import type { AgentSkillOutcome, LookPurpose } from './skills'
import type { AgentMode, AgentTurnParams } from './turn-params'

/** 智能体可调用的工具。 */
export type AgentToolName =
  | 'readProduction'
  | 'writeProduction'
  | 'proposeProductionEdit'
  | 'proposeProductionAssets'
  | 'proposeStoryboard'
  | 'planImageBatch'
  | 'proposeBatchGeneration'
  | 'readBatchAnalysis'
  | 'proposeBatchAnalysis'
  | 'generateImage'
  | 'editImage'
  | 'viewImage'
  | 'viewVideo'
  | 'readConversationImages'
  | 'readLibrary'
  | 'readCanvas'
  | 'createNodes'
  | 'updateNodes'
  | 'connectNodes'
  | 'deleteNodes'
  | 'arrangeNodes'
  | 'runNodes'
  | 'applyScriptPlan'
  | 'importCanvasImage'
  | 'runStoryboardFrames'
  | 'generateVideo'
  | 'loadSkill'
  | 'arrangeTimeline'
  | 'saveAsset'
  | 'saveLook'
  | 'editCanvasObject'
  | 'arrangeCanvas'
  | 'webSearch'
  | 'webFetch'
  | 'fetchImage'
  | 'fetchListingImages'

/** 联网工具读到的一条来源：搜索结果或抓取的网页。面板照它列链接，回放照它列网址。 */
export interface AgentWebSource {
  readonly title: string
  readonly url: string
}

/**
 * 取图工具存下的一张网图。`imageId` 就是媒体对象 id：它已被本会话认领，改图与看图工具
 * 直接拿它当图片 id 用，不必再经过别的登记。
 */
export interface AgentFetchedImage {
  readonly imageId: string
  /** 跟完重定向之后真正取到字节的那个地址。 */
  readonly sourceUrl: string
  readonly mime: string
  readonly width?: number
  readonly height?: number
  readonly name?: string
}

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
 * - `source_unavailable`：网页或图片来源拒绝访问、重定向失败或超出读取上限；换来源。
 * - `content_policy`：上游按内容安全策略拒绝了这次生成。原样重试稳定复现，出路是改提示词，
 *   在智能体这一侧就是让它改写后再提交。
 * - `model_unavailable`：当时要用的模型已下线或没有可用模型，同样交给智能体。
 * - `service_unavailable`：批次执行开关关着。重试同一个工具不会自己恢复，交给智能体换路径。
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
  | 'source_unavailable'
  | 'content_policy'
  | 'model_unavailable'
  | 'service_unavailable'
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
  'source_unavailable',
  'content_policy',
  'model_unavailable',
  'service_unavailable',
  'cancelled',
  'unknown',
]

export function isAgentToolErrorCode(value: unknown): value is AgentToolErrorCode {
  return AGENT_TOOL_ERROR_CODES.includes(value as AgentToolErrorCode)
}

/**
 * 队列任务失败时 worker 记下的 `error_type` 各归哪一类。两端共用：智能体卡片按它出文案，
 * 创作页的失败卡也按它取同一套译文，否则同一次失败在两处说两种话。
 */
export function taskFailureCode(errorType: TaskErrorType | null | undefined): AgentToolErrorCode {
  switch (errorType) {
    case 'upstream_timeout':
      return 'timeout'
    case 'plan_required':
    case 'invalid_request':
      return 'invalid_params'
    case 'content_policy':
      return 'content_policy'
    case 'model_unavailable':
      return 'model_unavailable'
    case 'upstream_no_image':
      return 'no_output'
    // 执行者丢了（ADR 0009）或上游的结局查不到：上游可能已经出图、已经计费，原样再跑一次
    // 就可能付两次钱，所以不归进可重试的那几类。
    case 'upstream_result_unknown':
    case 'interrupted':
      return 'result_unknown'
    default:
      return 'upstream_error'
  }
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
  /**
   * 图片产物归档成的云媒体（`media_objects.id`）。面板读历史时补上；有它就按媒体身份取图、
   * 当参考图按 id 发，不再经队列端点下载原图或重新上传。实时流里的结果卡还没有。
   */
  readonly mediaId?: string
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

/** 画布元素名称的长度上限，与 `ProjectImage.name` 的校验同一条。 */
export const AGENT_CANVAS_NAME_MAX_CHARS = 500

/** 一次画布对象改动的最大条数：一句话改一屏够用，再多就该分批说清楚改了什么。 */
export const AGENT_CANVAS_EDIT_MAX = 50

/**
 * 对画布上一个已有对象的属性改动。**全是绝对值，没有相对位移**——交付层在断线重连后
 * 会重放同一条结果，相对量重放一次就叠加一次，绝对量重放多少次结果都一样。
 *
 * 缺席的字段表示「这一项不动」，不是「清空」。组页签是例外：空串表示清掉。
 */
export interface AgentCanvasEdit {
  readonly elementId: string
  readonly name?: string
  readonly x?: number
  readonly y?: number
  readonly width?: number
  readonly height?: number
  /**
   * 挂在这张图上方的组页签。缺席表示不动；空串表示清掉。
   * 它写在图片的 meta 上，跟着图走，不进下一次生成的提示词。
   */
  readonly section?: string
}

/** 改画布这一步的结果：画布照它逐条打补丁。 */
export interface AgentCanvasEditPlan {
  readonly edits: readonly AgentCanvasEdit[]
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
  /** 任务结算后的实扣积分；任务仍在跑或旧记录查不到账时缺席。 */
  readonly chargedCredits?: number
  /** 视频任务实际提交的档位；任务成功时记到产物上。 */
  readonly video?: VideoGenerationRecord
  /**
   * 智能体提交时要求成功后回来复核（局部改图总是要）。失败一律唤醒，与它无关；界面据此知道
   * 任务结束后会不会有一轮唤醒要挂上。
   */
  readonly review?: true
}

/**
 * 保存卡片：智能体备好一条素材或一条模板，**落库这件事归用户按那一下**。卡片的内容随工具结果
 * 落库，所以刷新、换设备后它还在原处，还能按下保存；已经保存过的那张不再是入口（`saved`）。
 *
 * 图片没有跟着卡片走：卡上只有图片 id，字节由浏览器按自己那套解析链取（工具产物、本轮附图、
 * 画布对象），再写进本机记录——记录是本机的东西，服务端不替它保管一份。
 */
export type AgentSaveCardStatus = 'pending' | 'saved'

/** 卡上的一张视角：素材里的一张图，连同它的视角标签与来源。 */
export interface AgentSaveCardView {
  readonly imageId: string
  readonly label: (typeof ASSET_VIEW_LABELS)[number]
  readonly source: (typeof ASSET_VIEW_SOURCES)[number]
}

/** 存素材的那张卡。`assetKind` 是素材的类别（产品 / 人物）——`kind` 这个名字被卡的类型占着。 */
export interface AgentAssetSaveCard {
  readonly kind: 'asset'
  readonly status: AgentSaveCardStatus
  /** 保存后落成的本机素材 id；`pending` 时缺席。 */
  readonly recordId?: string
  readonly name: string
  readonly assetKind: (typeof ASSET_KINDS)[number]
  readonly background: (typeof ASSET_BACKGROUNDS)[number]
  /** 有序，第一条是封面。用户可以在卡上去掉几张，真正存下的以他按下保存时留着的那几张为准。 */
  readonly views: readonly AgentSaveCardView[]
}

/** 存模板的那张卡：一份技能正文加它钉死的模型、尺寸、素材位与图片。 */
export interface AgentLookSaveCard {
  readonly kind: 'look'
  readonly status: AgentSaveCardStatus
  readonly recordId?: string
  /** 要改写的那条模板；缺席即新建一条。 */
  readonly lookId?: string
  readonly name: string
  readonly description: string
  readonly purpose: LookPurpose
  /** frontmatter 之后的分节正文。 */
  readonly body: string
  readonly model: string
  readonly size: string
  readonly slotCount: number
  readonly referenceImageIds: readonly string[]
  readonly coverImageId?: string
}

export type AgentSaveCard = AgentAssetSaveCard | AgentLookSaveCard

export type AgentSaveCardKind = AgentSaveCard['kind']

/** Visual conclusions are accepted only after these pixels were dispatched to the model. */
export interface AgentVisualEvidence {
  readonly imageId: string
  readonly source: string
  readonly representation:
    | 'original'
    | 'preview'
    | 'region'
    | 'selection-location'
    | 'selection-crop'
    | 'tool-output'
  readonly width: number | null
  readonly height: number | null
  readonly bytes: number
  readonly selection: boolean
}

export interface AgentVisualObservation {
  readonly imageId: string
  readonly observation: string
  readonly evidence: readonly AgentVisualEvidence[]
}

/**
 * Persisted canvas run card. Stage fields are present on authorization proposals.
 * Older cards only have a project, node ids, and sometimes `autoRun`; that flag never grants execution.
 * Execution credentials are never part of conversation history.
 */
export interface AgentCanvasRunProposal {
  readonly projectId: string
  readonly nodeIds: readonly string[]
  readonly nodeNames?: readonly string[]
  readonly authorizationId?: string
  readonly stage?: string
  readonly estimatedCredits?: number
  readonly budgetCap?: number
  readonly status?: 'pending' | 'active' | 'exhausted' | 'ended' | 'expired'
  /**
   * 服务端按本轮用户偏好写下的直接出图标记。为真时原标签页立即开跑，不弹确认卡。
   * 历史卡片没有这个字段，不能据此开跑。
   */
  readonly direct?: boolean
  readonly autoRun?: boolean
  /** 首帧阶段的镜头表摘要。确认这条授权即把该分镜表定稿。 */
  readonly storyboard?: StoryboardStageSummary
  /**
   * 提案时冻结的执行规格。确认和预检必须与它一致；工作台之后改了模型或数量，要重新提案。
   */
  readonly specs?: readonly {
    readonly nodeId: string
    readonly model: string
    readonly quantity: number
    readonly unitMultiplier: number
  }[]
}

/** 一次工具调用的最终结果。它单独占一条助手消息，所以翻历史时与文字回复各就各位。 */
export interface AgentToolResultBlock {
  readonly canvasRun?: AgentCanvasRunProposal
  readonly canvasRead?: readonly { id: string; name: string }[]
  readonly productionDraftRevision?: number
  /** 实际视频档位在拟稿时冻结；确认卡、历史与结果共用。 */
  readonly video?: VideoGenerationRecord
  readonly analysisLimit?: AgentBatchAnalysisLimit
  readonly batchId?: string
  /** 这次调用写进批次的项 key：只给前端从回复里认出并去掉它们（BUG-56），不显示。 */
  readonly batchItemKeys?: readonly string[]
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
  /**
   * 这张卡是智能体模式「直接出图」关掉时被确认门拦下的调用（见 BFF `tool-gate.ts`）。智能体不知道
   * 停过：用户确认后同一轮接着跑；没确认就发了新消息，这张卡作废（`failed` + `cancelled`）。
   * 普通拟稿与旧记录缺席。
   */
  readonly gated?: true
  /**
   * 确认门拦下那一刻交给模型的回执原文（版本数、尺寸都在里面）。续跑把它原样接回历史，
   * 模型在确认前后看到的是同一句话。只有确认门的卡有；旧记录缺席。
   */
  readonly gateReceipt?: string
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
  /** 改画布对象这一步的结果：画布照它改名称 / 几何。缺席即这条不是改画布，或者没有可改的对象。 */
  readonly canvasEdit?: AgentCanvasEditPlan
  /**
   * 这次调用备好的保存卡片，连同它此刻存没存过。缺席即这条不是保存工具。
   * 用户按下保存后由 `POST .../saves` 就地改写成 `saved`，所以它是这张卡的唯一真相。
   */
  readonly saveCard?: AgentSaveCard
  /** 搜索或抓取网页这一步读到的来源。缺席即这条不是联网工具，或者什么也没读到。 */
  readonly sources?: readonly AgentWebSource[]
  /** 取图这一步存下的网图。缺席即这条不是取图工具，或者没有取到。 */
  readonly fetchedImages?: readonly AgentFetchedImage[]
  readonly visualObservations?: readonly AgentVisualObservation[]
}

/**
 * 没有唤醒智能体的原因：积分不足以再起一轮；用户没说话时已经连续自动唤醒了
 * {@link AGENT_MAX_CONSECUTIVE_WAKES} 次。
 */
export type AgentWakeSkipReason =
  | 'insufficient_credits'
  | 'quota_exceeded'
  | 'access_denied'
  | 'wake_limit'

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

export type AgentToolStage = 'submitted' | 'running'

/** 归一化到原图宽高的矩形：0–1，原点在左上。 */
export interface AgentNormalizedBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** 分割提示点：`include` 为真是落在目标上的点，为假是明确不改的点。 */
export interface AgentMaskPromptPoint {
  readonly x: number
  readonly y: number
  readonly include: boolean
}

/**
 * 建议蒙版由谁给：服务端分割模型（`server`，带 `maskMediaId`）、浏览器里的分割模型（`browser`，
 * 旧提议才有，卡片已不再在浏览器里分割），或者只按框栅格化的粗略范围（`box`）。
 */
type AgentMaskSegmentation = 'server' | 'browser' | 'box'

/**
 * 画面里有几个相似对象时（例如两只杯子）逐个列出的区域，卡片上按编号显示，用户点编号增减。
 * `selected` 是智能体判断的要改的那几个；生效的仍是用户确认带回来的那份蒙版。
 */
export interface AgentMaskRegion {
  /** 从 1 开始的显示编号，按从左到右、从上到下排。 */
  readonly number: number
  readonly label?: string
  readonly box: AgentNormalizedBox
  readonly points?: readonly AgentMaskPromptPoint[]
  readonly selected: boolean
  /** 服务端分割出的这个区域的蒙版（编辑格式，与原图同尺寸）；分割失败时缺席，卡片按框画。 */
  readonly maskMediaId?: string
}

/**
 * 智能体提议的修改范围（`proposeEditRegion` 签发）。模型只给对象名、外接框与提示点；
 * 生效的蒙版永远是用户在卡片上确认、随下一条用户消息带回来的那一份。
 */
export interface AgentMaskProposal {
  readonly id: string
  /** 要改的那张图在会话里的 id；确认后的参考图沿用它。 */
  readonly imageId: string
  /** 原图像素所在的媒体对象；卡片按它取原件，回答也按它引用，不经任何缩放。 */
  readonly mediaId: string
  readonly width: number
  readonly height: number
  /** 要改的对象，名词短语，例如「杯身和把手」。 */
  readonly target: string
  /** 要改成什么，取自用户原话。 */
  readonly change: string
  /** 明确不动的东西。 */
  readonly keep: readonly string[]
  readonly box: AgentNormalizedBox
  readonly points?: readonly AgentMaskPromptPoint[]
  readonly segmentation: AgentMaskSegmentation
  /** 服务端分割出的建议蒙版（不透明保留、透明重绘，与原图同尺寸）。有 `regions` 时由各区域合成。 */
  readonly maskMediaId?: string
  /** 相似对象逐个编号；缺席表示只有一个目标（`box` / `points` / `maskMediaId` 就是它）。 */
  readonly regions?: readonly AgentMaskRegion[]
  /**
   * 要改的是选中对象以外的部分（通常是换背景）。蒙版仍是要保留的主体；卡片显示与确认时
   * 取反，并往主体边缘里收一圈，让发丝、肩线这一圈也由模型对着新背景重画。
   */
  readonly invert?: boolean
  /** 这次局部编辑会用的模型；只会是支持蒙版的 GPT Image 系列。 */
  readonly model: { readonly id: string; readonly label: string }
  /** 用户选的模型不支持蒙版时记下原来那个；确认即同意改用 `model`。 */
  readonly switchedFrom?: { readonly id: string; readonly label: string }
}

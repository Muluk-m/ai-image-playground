import type { AgentTool } from '@earendil-works/pi-agent-core'
import type {
  AgentBackgroundJob,
  AgentCanvasEditPlan,
  AgentFetchedImage,
  AgentMode,
  AgentSaveCard,
  AgentSkillOutcome,
  AgentTimelinePlan,
  AgentToolArtifact,
  AgentToolCallSnapshot,
  AgentToolName,
  AgentToolStage,
  AgentTurnParams,
  AgentWebSource,
} from '@image-playground/shared'
import type { Static, TSchema } from 'typebox'
import type { ChatAttempt } from '../../chatCompletion'
import type { AgentAutoSubmitBudget } from '../auto-submit'
import type { AgentImageSource } from '../images'
import type { MaskedEditPlan } from '../masked-plan'
import type { TurnAuthorizationText } from '../turn-authorization'

/**
 * 这一轮的工具清单要按谁来筛。不是每个工具都对所有人在场：存素材、存模板要写进这个人的
 * 素材库，没登录就没有可写的地方，清单里也就不该出现它们。
 *
 * 只带 userId：能力开关是部署的事，各工具自己问（见 `lib/capabilities.ts`）。
 */
export interface AgentToolAudience {
  readonly userId: string | null
}

/** 工具跑在 BFF 进程里，身份与轮的归属由这里带过去。 */
export interface AgentToolContext {
  /** 这一轮要创作什么。工具清单、技能清单与逐工具指引都按它过滤。 */
  readonly mode: AgentMode
  readonly conversationId: string
  readonly turnId: string
  readonly userId: string | null
  readonly deviceId: string
  /** 外部副作用开始前确认当前 BFF 仍拥有这一轮。 */
  readonly assertExecution?: () => Promise<void>
  /** 模型说的图片 id 到字节的唯一出口。 */
  readonly images: AgentImageSource
  /** 此刻的授权原文；缺席即这一轮没有授权原文可核对。 */
  readonly authorization?: () => TurnAuthorizationText
  /** 「这次付费操作能不能提交」的唯一回答者；缺席即这一轮没有遮罩计划要守。 */
  readonly maskedEditPlan?: MaskedEditPlan
  /** 这一轮用户在参数浮层里选的生成参数；缺席即全部按部署默认。 */
  readonly params?: AgentTurnParams
  /**
   * 出图模式的每轮自动提交额度；缺席即这一轮不自动提交（对话模式，生成工具只拟稿）。
   * 领得到额度的调用当场提交并计费，领不到的退回等待确认。
   */
  readonly autoSubmit?: AgentAutoSubmitBudget
  /** 续跑轮里已经提交的后台调用，用于提交去重。 */
  readonly replay?: AgentSubmissionReplay
  /**
   * 搜索网页那一次额外模型调用的记账口：一次搜索就是一次上游调用，花的钱要落进这一轮的
   * 调用记录（`agent_model_calls`，`purpose: 'web_search'`）。它由平台承担，不进结算，
   * 但没有它运营就看不见这笔成本。缺席即这一轮没有账本可记。
   */
  readonly recordWebSearch?: (attempt: ChatAttempt) => Promise<void>
}

/** 被打断那一轮已经提交的一次调用：按调用内容算出的幂等键，与它提交出的后台任务。 */
export interface AgentReplayedSubmission {
  readonly key: string
  readonly job: AgentBackgroundJob
}

/** 续跑轮里的提交去重：每个已提交的任务只抵掉一次同样的调用。 */
export interface AgentSubmissionReplay {
  take(key: string): AgentBackgroundJob | undefined
}

/**
 * 进行中的 `onUpdate` 只填 `stage`，终局填 `artifacts`；提交成后台任务的调用填 `job`，
 * 产物要等任务结束才有。
 */
export interface AgentToolDetails {
  readonly executedPrompt?: string
  readonly stage?: AgentToolStage
  readonly artifacts?: readonly AgentToolArtifact[]
  readonly job?: AgentBackgroundJob
  readonly anchorObjectId?: string
  /**
   * 这次调用只拟了稿：请求已经准备齐全、存成待确认的草稿，但没有提交任何任务，也没有花钱。
   * 卡片停在「等待确认」，用户确认后由 `confirmations.ts` 按冻结的材料提交。
   */
  readonly awaitingConfirmation?: true
  /** 读取技能这一步读到了什么；只有那个工具会填。 */
  readonly skill?: AgentSkillOutcome
  /** 排时间线的结果；只有那个工具会填。 */
  readonly timeline?: AgentTimelinePlan
  /** 改画布对象的结果；只有那个工具会填。 */
  readonly canvasEdit?: AgentCanvasEditPlan
  /** 备好的保存卡片；只有存素材、存模板那两个工具会填。 */
  readonly saveCard?: AgentSaveCard
  /** 联网工具读到的来源；只有搜索与抓取网页会填。 */
  readonly sources?: readonly AgentWebSource[]
  /** 取图工具存下的网图；只有它会填。 */
  readonly fetchedImages?: readonly AgentFetchedImage[]
}

/**
 * 模型给的参数，按本工具 schema 定型。字段名与类型是 schema 说的，值却是模型的原话：
 * 工具起跑这一刻 pi 还没校验过（见 `adapter.ts`），所以每一项都可能缺，形状也可能不对，
 * `call()` 里该有的运行时兜底一个都不能省。
 */
export type AgentToolArgs<P extends TSchema> = Partial<Static<P>>

/** 一次调用起跑时就能从参数算出来的全部。面板照它出卡，画布照它占位。 */
export interface AgentToolCall {
  /** 面板上这次调用的一行标签。 */
  readonly title: string
  /**
   * 这次调用会落几件产物。工具还没跑完时画布就照这个数先占位，所以它必须和真正提交的
   * 张数同一个算式。缺席即这个工具不落画布（查素材库），画布不占位。
   */
  readonly outputCount?: number
  /**
   * 那张「产出要贴着放」的图在模型词汇里的 id（可能是 `image 2` 这类编号，由
   * `AgentImageSource.identify` 翻成真 id）。与结果里的 `anchorObjectId` 同源。
   */
  readonly anchor?: string
  /** 送进上游的完整提示词，结果卡展开给用户看；缺席即这个工具没有提示词可给。 */
  readonly prompt?: string
  /** 参数里引用的图，按模型词汇写（可能是 `image 2`），参数快照里翻成真 id。 */
  readonly references?: readonly string[]
}

export interface AgentToolDefinition<P extends TSchema = TSchema> {
  readonly name: AgentToolName
  /** 哪些创作类型看得见这个工具。视频轮也要生图改图——首帧要先画出来再改。 */
  readonly modes: readonly AgentMode[]
  /** 面板与模型清单上的短名。 */
  readonly label: string
  /** 给模型看的工具说明。 */
  readonly description: string
  /**
   * 这个工具只拟稿，不自己提交：它的每次调用都停在「等待确认」，由用户在卡片上确认后才建任务。
   * 起跑时因此不报占位数——那一刻画布上还不会有东西要占位（见 `agentToolStart`）。
   */
  readonly confirms?: true
  /**
   * 进系统提示词的那一句用法指引。工具不在场时它跟着一起消失。
   * 写成函数就是「这一句随部署变」——生视频的档位跟着运行期解析到的那个模型走。
   */
  readonly guidance: string | (() => string)
  readonly parameters: P
  /**
   * 这个部署此刻要发给模型的那一份参数 schema：形状与 `parameters` 完全一致，只有各字段的
   * 说明随运行期解析到的模型变；缺席即原样发 `parameters`。模型收到的清单、预扣估算读的声明
   * 与系统提示词里的指引都从这一处出，三者仍是同一份。
   *
   * **值的集合不许在这里收窄。** 收窄了模型就只能替用户挑一个别的档位，而那正是要治的病：
   * 用户明说的约束被静默换掉。留着它填得出来，执行时才有机会如实说「这个模型做不到」。
   */
  currentParameters?(): P
  /**
   * 这个工具失败时整轮是不是就该停。生图失败停下，因为模型会绕着缺掉的图接着编；
   * 换成模型可以改参数重试的工具就填 `continue`。
   */
  readonly onError: 'abort' | 'continue'
  /**
   * 部署开关；缺席即到处都在。关掉时工具不进模型的清单，历史里的结果照样认得出来。
   * 起轮之前算清单 token 时没有 `audience`（那一刻还没定下是谁），按最小清单算。
   */
  available?(mode: AgentMode, audience?: AgentToolAudience): boolean
  /**
   * 提交生成任务的工具才有：这一轮的参数下要用哪个模型。有它，这次调用起跑时就记一份
   * 参数快照（{@link AgentToolCallSnapshot}），失败记录与重试都从那里取参数。
   * 解析不出来就返回 undefined，快照照记，只是没有模型。
   */
  target?(params: AgentTurnParams | undefined): AgentToolCallSnapshot['target']
  /**
   * 这次调用的自述。参数残缺时退回默认值，绝不抛——抛了就是把一次能跑的调用挡在门外。
   * 带上这一轮的创作类型：同一个名字在两个 mode 下未必指同一件事，起跑这一行标签要按
   * 这一轮看得见的那份清单写。
   */
  call(args: AgentToolArgs<P>, mode: AgentMode): AgentToolCall
  execute(context: AgentToolContext): AgentTool<P, AgentToolDetails>['execute']
}

/**
 * 一个工具随每次请求发给模型的那一份声明。清单占的 token 全在这三项里，所以预扣估算
 * 读的就是它——而不是另列一份工具名。
 */
export interface AgentToolDeclaration<P extends TSchema = TSchema> {
  readonly name: string
  readonly description: string
  readonly parameters: P
}

/** 注册表与轮看到的工具：参数类型已经在 `defineAgentTool` 那一处被擦掉。 */
export interface AgentToolSpec {
  readonly name: AgentToolName
  readonly modes: readonly AgentMode[]
  /** 系统提示词里的那一句。随部署变，所以每次现问，不缓存成常量。 */
  guidance(): string
  readonly onError: 'abort' | 'continue'
  /** 只拟稿、由用户确认后才提交的工具；起跑时不占画布。 */
  readonly confirms?: true
  /** `create` 出来的工具照它填，估算也读它：同一份声明，不会各说各的。 */
  declaration(): AgentToolDeclaration
  available?(mode: AgentMode, audience?: AgentToolAudience): boolean
  call(args: unknown, mode: AgentMode): AgentToolCall
  /** 起跑时的参数快照，图片 id 由调用方翻译；缺席即这个工具不提交生成任务，不记快照。 */
  snapshot?(
    args: unknown,
    mode: AgentMode,
    params: AgentTurnParams | undefined,
  ): Omit<AgentToolCallSnapshot, 'imageIds'>
  create(context: AgentToolContext): AgentTool
}

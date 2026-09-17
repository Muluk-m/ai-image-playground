import type { AgentTool } from '@earendil-works/pi-agent-core'
import type {
  AgentMode,
  AgentSkillOutcome,
  AgentToolArtifact,
  AgentToolName,
  AgentToolStage,
  AgentTurnParams,
} from '@image-playground/shared'
import type { Static, TSchema } from 'typebox'
import type { AgentImageSource } from '../images'
import type { MaskedEditPlan } from '../masked-plan'

/** 工具跑在 BFF 进程里，身份与轮的归属由这里带过去。 */
export interface AgentToolContext {
  /** 这一轮要创作什么。工具清单、技能清单与逐工具指引都按它过滤。 */
  readonly mode: AgentMode
  readonly conversationId: string
  readonly turnId: string
  readonly userId: string | null
  readonly deviceId: string
  /** 模型说的图片 id 到字节的唯一出口。 */
  readonly images: AgentImageSource
  readonly editRequest?: () => { readonly revision: number; readonly instructions: string }
  /** 「这次付费操作能不能提交」的唯一回答者；缺席即这一轮没有遮罩计划要守。 */
  readonly maskedEditPlan?: MaskedEditPlan
  /** 这一轮用户在参数浮层里选的生成参数；缺席即全部按部署默认。 */
  readonly params?: AgentTurnParams
}

/** 进行中的 `onUpdate` 只填 `stage`，终局填 `artifacts`。 */
export interface AgentToolDetails {
  readonly executedPrompt?: string
  readonly stage?: AgentToolStage
  readonly artifacts?: readonly AgentToolArtifact[]
  readonly anchorObjectId?: string
  /** 读取技能这一步读到了什么；只有那个工具会填。 */
  readonly skill?: AgentSkillOutcome
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
}

export interface AgentToolDefinition<P extends TSchema = TSchema> {
  readonly name: AgentToolName
  /** 哪些创作类型看得见这个工具。视频轮也要生图改图——首帧要先画出来再改。 */
  readonly modes: readonly AgentMode[]
  /** 面板与模型清单上的短名。 */
  readonly label: string
  /** 给模型看的工具说明。 */
  readonly description: string
  /** 进系统提示词的那一句用法指引。工具不在场时它跟着一起消失。 */
  readonly guidance: string
  readonly parameters: P
  /**
   * 这个工具失败时整轮是不是就该停。生图失败停下，因为模型会绕着缺掉的图接着编；
   * 换成模型可以改参数重试的工具就填 `continue`。
   */
  readonly onError: 'abort' | 'continue'
  /** 部署开关；缺席即到处都在。关掉时工具不进模型的清单，历史里的结果照样认得出来。 */
  available?(mode: AgentMode): boolean
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
  readonly guidance: string
  readonly onError: 'abort' | 'continue'
  /** `create` 出来的工具照它填，估算也读它：同一份声明，不会各说各的。 */
  readonly declaration: AgentToolDeclaration
  available?(mode: AgentMode): boolean
  call(args: unknown, mode: AgentMode): AgentToolCall
  create(context: AgentToolContext): AgentTool
}

import type { AgentTool } from '@earendil-works/pi-agent-core'
import type {
  AgentToolArtifact,
  AgentToolName,
  AgentToolStage,
  AgentTurnParams,
} from '@image-playground/shared'
import type { AgentImageSource } from '../images'
import type { createMaskedEditPlan } from '../masked-plan'

/** 工具跑在 BFF 进程里，身份与轮的归属由这里带过去。 */
export interface AgentToolContext {
  readonly conversationId: string
  readonly turnId: string
  readonly userId: string | null
  readonly deviceId: string
  /** 模型说的图片 id 到字节的唯一出口。 */
  readonly images: AgentImageSource
  readonly editRequest?: () => { readonly revision: number; readonly instructions: string }
  readonly maskedEditPlan?: ReturnType<typeof createMaskedEditPlan>
  /** 这一轮用户在参数浮层里选的生成参数；缺席即全部按部署默认。 */
  readonly params?: AgentTurnParams
}

/** 进行中的 `onUpdate` 只填 `stage`，终局填 `artifacts`。 */
export interface AgentToolDetails {
  readonly executedPrompt?: string
  readonly stage?: AgentToolStage
  readonly artifacts?: readonly AgentToolArtifact[]
  readonly anchorObjectId?: string
}

export interface AgentToolDefinition {
  readonly name: AgentToolName
  /** 进系统提示词的那一句用法指引。工具不在场时它跟着一起消失。 */
  readonly guidance: string
  /** 面板上这次调用的一行标签，从模型给的参数算。 */
  title(args: unknown): string
  /**
   * 这次调用会落几件产物。工具还没跑完时画布就照这个数先占位，所以它必须和真正提交的
   * 张数同一个算式。缺席即这个工具不落画布（查素材库），画布不占位。
   */
  outputCount?(args: unknown): number
  /**
   * 模型给的参数里那张「产出要贴着放」的图，返回它在模型词汇里的 id（可能是 `image 2`
   * 这类编号，由 `AgentImageSource.identify` 翻成真 id）。与结果里的 `anchorObjectId` 同源。
   */
  anchor?(args: unknown): string | undefined
  /**
   * 这个工具失败时整轮是不是就该停。生图失败停下，因为模型会绕着缺掉的图接着编；
   * 换成模型可以改参数重试的工具就填 `continue`。
   */
  readonly onError: 'abort' | 'continue'
  /** 部署开关；缺席即到处都在。关掉时工具不进模型的清单，历史里的结果照样认得出来。 */
  available?(): boolean
  create(context: AgentToolContext): AgentTool
}

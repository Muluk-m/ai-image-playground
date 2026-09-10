import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { AgentToolArtifact, AgentToolName, AgentToolStage } from '@image-playground/shared'
import type { AgentImageSource } from '../images'

/** 工具跑在 BFF 进程里，身份与轮的归属由这里带过去。 */
export interface AgentToolContext {
  readonly conversationId: string
  readonly turnId: string
  readonly userId: string | null
  readonly deviceId: string
  /** 模型说的图片 id 到字节的唯一出口。 */
  readonly images: AgentImageSource
}

/** 进行中的 `onUpdate` 只填 `stage`，终局填 `artifacts`。 */
export interface AgentToolDetails {
  readonly stage?: AgentToolStage
  readonly artifacts?: readonly AgentToolArtifact[]
  readonly anchorImageId?: string
}

export interface AgentToolDefinition {
  readonly name: AgentToolName
  /** 面板上这次调用的一行标签，从模型给的参数算。 */
  title(args: unknown): string
  /**
   * 这个工具失败时整轮是不是就该停。生图失败停下，因为模型会绕着缺掉的图接着编；
   * 换成模型可以改参数重试的工具就填 `continue`。
   */
  readonly onError: 'abort' | 'continue'
  /** 部署开关；缺席即到处都在。关掉时工具不进模型的清单，历史里的结果照样认得出来。 */
  available?(): boolean
  create(context: AgentToolContext): AgentTool
}

import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { AgentToolImage, AgentToolName, AgentToolStage } from '@image-playground/shared'

/** 工具跑在 BFF 进程里，身份与轮的归属由这里带过去；任务因此能反查属于哪一轮。 */
export interface AgentToolContext {
  readonly conversationId: string
  readonly turnId: string
  readonly userId: string | null
  readonly deviceId: string
}

/**
 * 每个工具的结果细节都长这个样子，轮的事件漏斗照它取值，不按工具名分支。
 * 进行中的 `onUpdate` 只填 `stage`，终局填 `images`。
 */
export interface AgentToolDetails {
  readonly title: string
  readonly stage?: AgentToolStage
  readonly images?: readonly AgentToolImage[]
}

export interface AgentToolDefinition {
  readonly name: AgentToolName
  /** 面板上这次调用的一行标签，从模型给的参数算。 */
  title(args: unknown): string
  create(context: AgentToolContext): AgentTool
}

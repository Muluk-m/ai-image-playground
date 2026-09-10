import type { AgentToolImage, AgentToolStage, AgentToolStatus } from '@image-playground/shared'

export type AgentTurnStatus = 'idle' | 'running' | 'failed'

export interface AgentTextMessage {
  readonly kind: 'text'
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly text: string
  /** 本轮还在流的那条助手消息。 */
  readonly streaming: boolean
}

/** 一次工具调用在对话流里的那张结果卡。 */
export interface AgentToolMessage {
  readonly kind: 'tool'
  readonly id: string
  readonly toolCallId: string
  readonly title: string
  readonly status: AgentToolStatus | 'running'
  readonly stage?: AgentToolStage
  readonly images?: readonly AgentToolImage[]
  readonly message?: string
  /** 画布冲突：产出没有自动写入画布，卡上给手动放入的入口。 */
  readonly canvasConflict?: boolean
}

export type AgentPanelMessage = AgentTextMessage | AgentToolMessage

export type AgentPanelTab = 'chat' | 'history' | 'layers'

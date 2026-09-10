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
}

export type AgentPanelMessage = AgentTextMessage | AgentToolMessage

export type AgentPanelTab = 'chat' | 'history' | 'layers'

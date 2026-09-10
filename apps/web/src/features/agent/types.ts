import type { AgentToolArtifact, AgentToolStage, AgentToolStatus } from '@image-playground/shared'

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
  readonly artifacts?: readonly AgentToolArtifact[]
  readonly message?: string
  /** 产出贴着这个画布对象放；手动放入时也照这个位置。 */
  readonly anchorObjectId?: string
  /** 画布冲突：产出没有自动写入画布，卡上给手动放入的入口。 */
  readonly canvasConflict?: boolean
}

/** 一次澄清提问。末尾那条还没作答，可以点；它之后有用户消息的就是作过答的。 */
export interface AgentClarificationMessage {
  readonly kind: 'clarification'
  readonly id: string
  readonly question: string
  readonly options: readonly string[]
}

export type AgentPanelMessage = AgentTextMessage | AgentToolMessage | AgentClarificationMessage

export type AgentPanelTab = 'chat' | 'history' | 'layers'

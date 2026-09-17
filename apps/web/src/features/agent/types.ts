import type {
  AgentToolArtifact,
  AgentToolStage,
  AgentToolStatus,
  AgentTurnCost,
  AgentTurnStopReason,
} from '@image-playground/shared'

export type AgentTurnStatus = 'idle' | 'running' | 'failed'
export type AgentDeliveryStatus = 'pending' | 'placed' | 'unavailable' | 'failed'

export interface AgentTextMessage {
  readonly kind: 'text'
  readonly id: string
  readonly turnId: string
  readonly role: 'user' | 'assistant'
  readonly text: string
  /** 本轮还在流的那条助手消息。 */
  readonly streaming: boolean
  /** 刚发出、服务端还没回 turnStart 的用户消息：先上屏，等到真 id 再换掉。 */
  readonly pending?: true
}

/** 一次工具调用在对话流里的那张结果卡。 */
export interface AgentToolMessage {
  readonly kind: 'tool'
  readonly id: string
  readonly turnId: string
  readonly toolCallId: string
  readonly title: string
  readonly prompt?: string
  readonly status: AgentToolStatus | 'running'
  readonly stage?: AgentToolStage
  readonly artifacts?: readonly AgentToolArtifact[]
  readonly message?: string
  /** 产出贴着这个画布对象放；手动放入时也照这个位置。 */
  readonly anchorObjectId?: string
  /** 本机产物交付与工具生成分别完成，不改写工具状态或本轮消耗。 */
  readonly delivery?: AgentDeliveryStatus
}

/** 一次澄清提问。末尾那条还没作答，可以点；它之后有用户消息的就是作过答的。 */
export interface AgentClarificationMessage {
  readonly kind: 'clarification'
  readonly id: string
  readonly turnId: string
  readonly question: string
  readonly options: readonly string[]
}

export type AgentPanelMessage = AgentTextMessage | AgentToolMessage | AgentClarificationMessage

export type AgentPanelTab = 'chat' | 'history' | 'layers'

/** 一轮的页脚：进行中只有预扣数，结算后有耗时与实际消耗。 */
export interface AgentTurnFooter {
  readonly turnId: string
  readonly reservedCredits?: number
  readonly durationMs?: number
  readonly stopReason?: AgentTurnStopReason
  readonly cost?: AgentTurnCost
}

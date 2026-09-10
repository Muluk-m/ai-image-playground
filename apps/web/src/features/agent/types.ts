export type AgentTurnStatus = 'idle' | 'running' | 'failed'

export interface AgentPanelMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly text: string
  /** 本轮还在流的那条助手消息。 */
  readonly streaming: boolean
}

export type AgentPanelTab = 'chat' | 'history' | 'layers'

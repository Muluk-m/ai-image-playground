import type { AgentToolArtifact, AgentTurnParams } from './agent'
import type { ProductionMediaReference } from './production'
import type { VideoRequest } from './video-presets'

export interface ProductionGenerationReference {
  readonly reference: ProductionMediaReference
  readonly usage?: 'first-frame' | 'last-frame' | 'reference'
}
export interface ProductionGenerationBinding {
  readonly documentId: string
  readonly revision: number
  readonly target: 'look' | 'location' | 'clip'
  readonly targetId: string
  readonly snapshot: {
    readonly name: string
    readonly description: string
    readonly references: readonly ProductionMediaReference[]
    readonly shotIds?: readonly string[]
    readonly model?: string
    readonly video?: VideoRequest
  }
}
export interface ProductionGenerationDraftInput {
  readonly operationId: string
  readonly baseRevision: number
  readonly target: ProductionGenerationBinding['target']
  readonly targetId: string
  readonly prompt: string
  readonly model: string
  readonly params?: AgentTurnParams
  readonly video?: VideoRequest
  readonly references: readonly ProductionGenerationReference[]
}
export interface ProductionGenerationView {
  readonly draftId: string
  readonly messageId: string
  readonly draftRevision: number
  readonly production: ProductionGenerationBinding
  readonly model: string
  readonly prompt: string
  readonly params?: AgentTurnParams
  readonly video?: VideoRequest
  readonly references: readonly ProductionGenerationReference[]
  readonly status: string
  readonly taskId?: string
  readonly artifacts: readonly AgentToolArtifact[]
}

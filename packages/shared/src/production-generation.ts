import type {
  AgentToolArtifact,
  AgentToolErrorCode,
  AgentToolRetryOrigin,
  AgentTurnParams,
} from './agent'
import type { ProductionMediaReference } from './production'
import type { ProductionDependency } from './production-dependencies'
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
    readonly character?: {
      readonly id: string
      readonly name: string
      readonly description: string
    }
    readonly dependencies?: readonly ProductionDependency[]
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
  readonly errorCode?: AgentToolErrorCode
  readonly error?: string
  readonly retryOf?: AgentToolRetryOrigin
  readonly sourceChanged?: boolean
  readonly artifacts: readonly AgentToolArtifact[]
}

/** Frozen, safe submission fields for an explicitly selected export resource. */
export type ProductionExportGenerationMetadata =
  | { readonly source: 'imported' }
  | ({ readonly source: 'production'; readonly taskId: string } & Pick<
      ProductionGenerationView,
      | 'draftId'
      | 'draftRevision'
      | 'production'
      | 'model'
      | 'prompt'
      | 'params'
      | 'video'
      | 'references'
      | 'retryOf'
    >)

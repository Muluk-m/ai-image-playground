import type {
  AgentMediaReference,
  AgentToolArtifact,
  AgentTurnParams,
  AgentVisualEvidence,
} from './agent'
import type { AnalysisCoverage, AnalysisFinding, AnalysisInputSnapshot } from './analysis'
import type { QueueProvider, TaskStatus } from './queue-protocol'

export interface AgentBatchPriceSnapshot {
  readonly itemKey?: string
  readonly unit: 'image' | 'second' | 'kilo_token'
  readonly quantity: number
  readonly unitMultiplier: number
  readonly pricingVersion: string
  readonly quotedAt: number
  readonly validUntil: number | null
  readonly model: string
  readonly baseUnitCredits: number
  readonly outputPriceRatio: number
  readonly cachedInputPriceRatio: number
  readonly inputEstimateTokens: number
  readonly outputReserveTokens: number
  readonly exemption: 'none' | 'chat-free' | 'non-billing'
}

export type AgentBatchEstimate =
  | { readonly status: 'unavailable'; readonly reason: 'price_unavailable' }
  | {
      readonly status: 'available'
      readonly estimatedCredits: number
      readonly estimatedChargeCredits: number
      readonly snapshots: readonly AgentBatchPriceSnapshot[]
    }

export interface AgentBatchEstimates {
  readonly analysis: AgentBatchEstimate
  readonly generation: AgentBatchEstimate
}

interface AgentBatchItemBase {
  readonly key: string
  readonly ordinal: number
  readonly inputs: readonly AgentMediaReference[]
  readonly prompt: string
  readonly dependencies: readonly string[]
}
export interface AgentBatchGenerationItem extends AgentBatchItemBase {
  readonly kind: 'generation'
  readonly params: Omit<AgentTurnParams, 'autoSubmit'> & {
    readonly model: string
    readonly provider: QueueProvider
  }
}
export interface AgentBatchAnalysisItem extends AgentBatchItemBase {
  readonly kind: 'analysis'
  readonly params: Pick<
    AnalysisInputSnapshot,
    'model' | 'estimatedInputTokens' | 'evidence' | 'intent'
  >
}
export type AgentBatchItem = AgentBatchGenerationItem | AgentBatchAnalysisItem
export interface AgentBatchAnalysisResult {
  readonly findings: readonly AnalysisFinding[] | null
  readonly coverage: AnalysisCoverage | null
  readonly evidence: readonly AgentVisualEvidence[] | null
}

export interface AgentBatchAttemptSnapshot {
  readonly analysis?: AgentBatchAnalysisResult
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly completedAt: number
  readonly upstreamStatus: number | null
  readonly actualCredits: number | null
  readonly artifacts: readonly AgentToolArtifact[]
  readonly errorCode: string | null
  readonly message: string | null
}

export interface AgentBatchItemExecution {
  readonly analysis?: AgentBatchAnalysisResult
  readonly taskId: string
  readonly status: TaskStatus
  readonly attempt: number
  readonly actualCredits: number | null
  readonly artifacts?: readonly AgentToolArtifact[]
  readonly errorCode?: string | null
  readonly message?: string | null
}

export interface AgentBatchView {
  readonly id: string
  readonly conversationId: string | null
  readonly originTurnId: string
  readonly experience: 'chat' | 'canvas'
  readonly projectId: string | null
  readonly targetSnapshot: {
    readonly projectId: string | null
    readonly projectRevision: number | null
  }
  readonly version: number
  readonly digest: string
  readonly title: string
  readonly rule: string
  readonly itemCount: number
  readonly status: 'draft' | 'cancelled' | 'running' | 'paused' | 'closed'
  readonly executionEnabled: boolean
  readonly pauseReason?:
    | 'price_changed'
    | 'insufficient_credits'
    | 'input_limit'
    | 'upstream_auth'
    | 'model_unavailable'
    | null
  readonly retryItemKeys?: readonly string[]
  readonly retryRequiresResume?: boolean
  readonly confirmationRequired?: boolean
  readonly submittedCount?: number
  readonly actualCredits?: number
  readonly estimate: AgentBatchEstimates
  readonly createdAt: number
}

/** Successful coverage is backed by the currently approved attempt's model-call evidence. */
export interface AgentBatchAnalysisSummary {
  readonly complete: boolean
  readonly inspectionComplete: boolean
  readonly jointComparisons: readonly {
    readonly itemKey: string
    readonly taskId: string | null
    readonly attempt: number | null
    readonly status: TaskStatus
    readonly complete: boolean
    readonly requiredImageIds: readonly string[]
  }[]
  readonly requiredImageIds: readonly string[]
  readonly successfulImageIds: readonly string[]
  readonly missingImageIds: readonly string[]
  readonly unresolvedItemKeys: readonly string[]
  readonly findings: readonly (AnalysisFinding & {
    readonly itemKey: string
    readonly taskId: string
    readonly attempt: number
    readonly evidence: readonly AgentVisualEvidence[]
  })[]
}

export interface AgentBatchPage {
  readonly analysisSummary?: AgentBatchAnalysisSummary
  readonly batch: AgentBatchView
  readonly items: readonly (AgentBatchItem & {
    readonly execution?: AgentBatchItemExecution
    readonly attempts?: readonly AgentBatchItemExecution[]
    readonly progress?: AgentBatchItemProgress
    readonly blockedBy?: readonly string[]
  })[]
  readonly nextCursor: string | null
}

export type AgentBatchItemProgress =
  | 'pending'
  | 'ready'
  | 'in_flight'
  | 'completed'
  | 'failed'
  | 'reconciling'
  | 'blocked'
  | 'cancelled'

export interface AgentBatchUpdate {
  readonly expectedVersion: number
  readonly title: string
  readonly rule: string
  readonly items: readonly (
    | AgentBatchGenerationItem
    | (Omit<AgentBatchAnalysisItem, 'params'> & {
        readonly params: Pick<AnalysisInputSnapshot, 'model' | 'intent'>
      })
  )[]
}

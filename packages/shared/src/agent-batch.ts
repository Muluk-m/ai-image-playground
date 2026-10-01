import type { AgentMediaReference, AgentTurnParams } from './agent'
import type { QueueProvider } from './queue-protocol'

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

export interface AgentBatchItem {
  readonly key: string
  readonly ordinal: number
  readonly kind: 'generation'
  readonly inputs: readonly AgentMediaReference[]
  readonly prompt: string
  readonly params: Omit<AgentTurnParams, 'autoSubmit'> & {
    readonly model: string
    readonly provider: QueueProvider
  }
  readonly dependencies: readonly string[]
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
  readonly status: 'draft' | 'cancelled'
  readonly executionEnabled: false
  readonly estimate: AgentBatchEstimates
  readonly createdAt: number
}

export interface AgentBatchPage {
  readonly batch: AgentBatchView
  readonly items: readonly AgentBatchItem[]
  readonly nextCursor: string | null
}

export interface AgentBatchUpdate {
  readonly expectedVersion: number
  readonly title: string
  readonly rule: string
  readonly items: readonly AgentBatchItem[]
}

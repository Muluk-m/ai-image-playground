import type { ProductionClipPlan } from './production-clips'
/** 会话内有界制作文本；不代表媒体原件的长期存储。 */
export interface ProductionScene {
  readonly id: string
  readonly title: string
  readonly body: string
}
export interface ProductionContent {
  readonly shots?: readonly import('./production-storyboard').ProductionShot[]
  readonly clips?: readonly ProductionClipPlan[]
  readonly title: string
  readonly setting: string
  readonly outline: string
  readonly scenes: readonly ProductionScene[]
  readonly characters?: readonly ProductionCharacter[]
  readonly locations?: readonly ProductionLocation[]
}
export interface ProductionDocument {
  readonly id: string
  readonly conversationId: string
  readonly projectId: string | null
  readonly revision: number
  readonly content: ProductionContent
  readonly updatedAt: number
}
export interface ProductionMutation {
  readonly operationId: string
  readonly baseRevision: number
  readonly content: ProductionContent
}
export interface ProductionRevision {
  readonly revision: number
  readonly content: ProductionContent
  readonly source: 'user' | 'agent' | 'restore'
  readonly turnId?: string
  readonly createdAt: number
}
export interface ProductionRecord {
  readonly assetProposals?: readonly ProductionAssetProposal[]
  readonly storyboardProposals?: readonly import('./production-storyboard').ProductionStoryboardProposal[]
  readonly proposals?: readonly ProductionProposal[]
  readonly document: ProductionDocument
  readonly history: readonly ProductionRevision[]
  readonly receipts: readonly {
    readonly operationId: string
    readonly fingerprint: string
    readonly revision: number
  }[]
}
export const PRODUCTION_TEXT_MAX_CHARS = 100_000
export const PRODUCTION_SCENES_MAX = 100
export const PRODUCTION_HISTORY_MAX = 30
export const PRODUCTION_RECEIPTS_MAX = 200

export interface ProductionContext {
  readonly documentId: string
  readonly revision: number
  readonly target: 'setting' | 'outline' | 'scene' | 'shots' | 'shot' | 'look' | 'location' | 'clip'
  readonly lookId?: string
  readonly locationId?: string
  readonly clipId?: string
  readonly shotId?: string
  readonly sceneId?: string
  readonly quote?: { readonly start: number; readonly end: number; readonly text: string }
}
export interface ProductionProposal {
  readonly id: string
  readonly baseRevision: number
  readonly target: 'setting' | 'outline' | 'scene'
  readonly sceneId?: string
  readonly before: string
  readonly after: string
  readonly sourceTurnId: string
  readonly status: 'pending' | 'adopted' | 'discarded'
  readonly adoptedRevision?: number
  readonly createdAt: number
}
export const PRODUCTION_PROPOSALS_MAX = 20

export type ProductionMediaReference =
  | { readonly kind: 'media'; readonly mediaId: string }
  | { readonly kind: 'artifact'; readonly artifactId: string }
  | { readonly kind: 'asset'; readonly imageId: string }
export interface ProductionLook {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly reference?: ProductionMediaReference
}
export interface ProductionCharacter {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly looks: readonly ProductionLook[]
}
export interface ProductionLocation {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly reference?: ProductionMediaReference
}
export interface ProductionAssetProposal {
  readonly id: string
  readonly baseRevision: number
  readonly characters: readonly ProductionCharacter[]
  readonly locations: readonly ProductionLocation[]
  readonly sourceTurnId: string
  readonly status: 'pending' | 'adopted' | 'discarded'
  readonly adoptedRevision?: number
  readonly createdAt: number
}
export const PRODUCTION_ASSETS_MAX = 100

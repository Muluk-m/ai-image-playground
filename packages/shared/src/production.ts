/** 会话内有界制作文本；不代表媒体原件的长期存储。 */
export interface ProductionScene {
  readonly id: string
  readonly title: string
  readonly body: string
}
export interface ProductionContent {
  readonly title: string
  readonly setting: string
  readonly outline: string
  readonly scenes: readonly ProductionScene[]
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

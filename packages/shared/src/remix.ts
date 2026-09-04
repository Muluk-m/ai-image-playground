export const SHOT_TYPES = [
  'main',
  'scene',
  'topdown',
  'detail',
  'selling-point',
  'spec-diagram',
  'other',
] as const

export type ShotType = (typeof SHOT_TYPES)[number]

/** 归一化到 0-1 的产品包围框，原点在图片左上角。 */
export interface ProductBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface CompetitorBrief {
  readonly shotType: ShotType
  readonly composition: string
  readonly camera: string
  readonly lighting: string
  readonly background: string
  readonly props: string[]
  readonly textZones: string[]
  readonly palette: string[]
  readonly productBox: ProductBox | null
  readonly suggestedTitle?: string
}

export interface ProductContext {
  readonly name: string
  readonly description: string
}

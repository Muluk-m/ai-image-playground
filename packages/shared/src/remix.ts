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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function parseUnit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(1, Math.max(0, value))
}

/** `undefined` 是框本身不合法，`null` 是画面里本就没有产品。 */
export function parseProductBox(value: unknown): ProductBox | null | undefined {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return undefined
  const box = value as Record<string, unknown>
  const x = parseUnit(box.x)
  const y = parseUnit(box.y)
  const w = parseUnit(box.w)
  const h = parseUnit(box.h)
  if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined
  return { x, y, w, h }
}

/** 视觉模型的输出与 BFF 的应答是同一个形状，两侧共用这一个解析器。 */
export function parseCompetitorBrief(value: unknown): CompetitorBrief | null {
  if (typeof value !== 'object' || value === null) return null
  const { shotType, composition, camera, lighting, background } = value as Record<string, unknown>
  const { props, textZones, palette, productBox, suggestedTitle } = value as Record<string, unknown>
  const type = SHOT_TYPES.find((candidate) => candidate === shotType)
  const box = parseProductBox(productBox)
  if (!type || box === undefined) return null
  if (
    typeof composition !== 'string' ||
    typeof camera !== 'string' ||
    typeof lighting !== 'string' ||
    typeof background !== 'string'
  ) {
    return null
  }
  if (!isStringArray(props) || !isStringArray(textZones) || !isStringArray(palette)) return null
  return {
    shotType: type,
    composition,
    camera,
    lighting,
    background,
    props,
    textZones,
    palette,
    productBox: box,
    ...(typeof suggestedTitle === 'string' ? { suggestedTitle } : {}),
  }
}

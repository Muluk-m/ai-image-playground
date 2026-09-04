import { type CompetitorBrief, type ProductContext, SHOT_TYPES } from '@image-playground/shared'
import { bffBaseUrl } from '../../../lib/runtimeConfig'

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

const UNAVAILABLE = '竞品图分析没有返回可用的简报'

export async function analyzeCompetitorImages(
  images: readonly string[],
  product: ProductContext,
  fetcher: Fetcher = fetch,
): Promise<CompetitorBrief[]> {
  const response = await fetcher(`${bffBaseUrl()}/api/remix/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ images, product }),
  })
  const briefs = response.ok ? parseBriefs(await response.json()) : null
  if (!briefs) throw new Error(UNAVAILABLE)
  return briefs
}

function parseBriefs(body: unknown): CompetitorBrief[] | null {
  if (typeof body !== 'object' || body === null) return null
  const { briefs } = body as Record<string, unknown>
  if (!Array.isArray(briefs)) return null
  const parsed = briefs.map(parseBrief)
  return parsed.every((brief): brief is CompetitorBrief => brief !== null) ? parsed : null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function parseBrief(value: unknown): CompetitorBrief | null {
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

function parseProductBox(value: unknown): CompetitorBrief['productBox'] | undefined {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return undefined
  const box = value as Record<string, unknown>
  const numbers = (['x', 'y', 'w', 'h'] as const).map((key) => box[key])
  if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined
  const [x, y, w, h] = numbers as number[]
  return { x, y, w, h }
}

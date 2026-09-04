import {
  type CompetitorBrief,
  type ProductContext,
  parseCompetitorBrief,
} from '@image-playground/shared'
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
  const parsed = briefs.map(parseCompetitorBrief)
  return parsed.every((brief): brief is CompetitorBrief => brief !== null) ? parsed : null
}

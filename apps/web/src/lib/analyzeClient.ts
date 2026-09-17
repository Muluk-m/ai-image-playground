import {
  type CompetitorBrief,
  type ProductContext,
  parseCompetitorBrief,
} from '@image-playground/shared'
import { i18next } from '../i18n'
import { authenticatedBffFetch } from './authClient'
import { bffBaseUrl } from './runtimeConfig'

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

const unavailable = (): string => i18next.t('bffClient.analyzeUnavailable', { ns: 'lib' })

export async function analyzeCompetitorImages(
  images: readonly string[],
  product: ProductContext,
  fetcher: Fetcher = authenticatedBffFetch,
): Promise<CompetitorBrief[]> {
  const response = await fetcher(`${bffBaseUrl()}/api/remix/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ images, product }),
  })
  const briefs = response.ok ? parseBriefs(await response.json()) : null
  if (!briefs) throw new Error(unavailable())
  return briefs
}

function parseBriefs(body: unknown): CompetitorBrief[] | null {
  if (typeof body !== 'object' || body === null) return null
  const { briefs } = body as Record<string, unknown>
  if (!Array.isArray(briefs)) return null
  const parsed = briefs.map(parseCompetitorBrief)
  return parsed.every((brief): brief is CompetitorBrief => brief !== null) ? parsed : null
}

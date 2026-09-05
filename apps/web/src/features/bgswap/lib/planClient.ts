import {
  type BackgroundPlanResult,
  type PromptLanguage,
  parseBackgroundPlan,
} from '@image-playground/shared'
import { bffBaseUrl } from '../../../lib/runtimeConfig'

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

const UNAVAILABLE = '没拿到可用的背景方案'

export interface BackgroundPlanRequest {
  image: string
  preference?: string
  language?: PromptLanguage
}

export async function requestBackgroundPlan(
  request: BackgroundPlanRequest,
  fetcher: Fetcher = fetch,
): Promise<BackgroundPlanResult> {
  const preference = request.preference?.trim()
  const response = await fetcher(`${bffBaseUrl()}/api/bgswap/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      image: request.image,
      ...(preference ? { preference } : {}),
      ...(request.language ? { language: request.language } : {}),
    }),
  })
  const result = response.ok ? parsePlanResult(await response.json()) : null
  if (!result) throw new Error(UNAVAILABLE)
  return result
}

function parsePlanResult(body: unknown): BackgroundPlanResult | null {
  const plan = parseBackgroundPlan(body)
  if (!plan) return null
  const { prompt } = body as Record<string, unknown>
  if (typeof prompt !== 'string' || !prompt.trim()) return null
  return { ...plan, prompt }
}

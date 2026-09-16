import {
  type BackgroundPlanResult,
  type BgSceneType,
  type BgSwapMode,
  type PromptLanguage,
  parseBackgroundPlan,
  parseSceneScan,
} from '@image-playground/shared'
import { i18next } from '../../../i18n'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { bffBaseUrl } from '../../../lib/runtimeConfig'

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

export interface BackgroundPlanRequest {
  image: string
  preference?: string
  language?: PromptLanguage
  mode?: BgSwapMode
}

export async function requestBackgroundPlan(
  request: BackgroundPlanRequest,
  fetcher: Fetcher = authenticatedBffFetch,
): Promise<BackgroundPlanResult> {
  const preference = request.preference?.trim()
  const response = await fetcher(`${bffBaseUrl()}/api/bgswap/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      image: request.image,
      ...(preference ? { preference } : {}),
      ...(request.language ? { language: request.language } : {}),
      ...(request.mode ? { mode: request.mode } : {}),
    }),
  })
  const result = response.ok ? parsePlanResult(await response.json()) : null
  if (!result) throw new Error(i18next.t('plan.unavailable', { ns: 'productShots' }))
  return result
}

/** 预检：拉完图就问画面类型，好在批量与单张点击前知道哪些是示意图。 */
export async function requestSceneScan(
  image: string,
  fetcher: Fetcher = authenticatedBffFetch,
): Promise<BgSceneType> {
  const response = await fetcher(`${bffBaseUrl()}/api/bgswap/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image }),
  })
  const scan = response.ok ? parseSceneScan(await response.json()) : null
  if (!scan) throw new Error(i18next.t('plan.scanUnavailable', { ns: 'productShots' }))
  return scan.sceneType
}

function parsePlanResult(body: unknown): BackgroundPlanResult | null {
  const plan = parseBackgroundPlan(body)
  if (!plan) return null
  const { prompt } = body as Record<string, unknown>
  if (typeof prompt !== 'string' || !prompt.trim()) return null
  return { ...plan, prompt }
}

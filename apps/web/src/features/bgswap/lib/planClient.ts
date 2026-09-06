import {
  type BackgroundPlanResult,
  type BgSceneType,
  type PromptLanguage,
  parseBackgroundPlan,
  parseSceneScan,
} from '@image-playground/shared'
import { bffBaseUrl } from '../../../lib/runtimeConfig'

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

const UNAVAILABLE = '没拿到可用的背景方案'
const SCAN_UNAVAILABLE = '没认出这张图的画面类型'

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

/** 预检：拉完图就问画面类型，好在批量与单张点击前知道哪些是示意图。 */
export async function requestSceneScan(
  image: string,
  fetcher: Fetcher = fetch,
): Promise<BgSceneType> {
  const response = await fetcher(`${bffBaseUrl()}/api/bgswap/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image }),
  })
  const scan = response.ok ? parseSceneScan(await response.json()) : null
  if (!scan) throw new Error(SCAN_UNAVAILABLE)
  return scan.sceneType
}

function parsePlanResult(body: unknown): BackgroundPlanResult | null {
  const plan = parseBackgroundPlan(body)
  if (!plan) return null
  const { prompt } = body as Record<string, unknown>
  if (typeof prompt !== 'string' || !prompt.trim()) return null
  return { ...plan, prompt }
}

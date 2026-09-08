import {
  parseStoryboardPlan,
  type StoryboardPlan,
  type StoryboardPlanRequest,
} from '@image-playground/shared'
import { bffBaseUrl } from './runtimeConfig'

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

const UNAVAILABLE = '分镜脚本没有生成成功'

export async function planStoryboard(
  request: StoryboardPlanRequest,
  fetcher: Fetcher = fetch,
): Promise<StoryboardPlan> {
  const response = await fetcher(`${bffBaseUrl()}/api/storyboard/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  const plan = response.ok ? parsePlan(await response.json(), request) : null
  if (!plan) throw new Error(UNAVAILABLE)
  return plan
}

function parsePlan(body: unknown, request: StoryboardPlanRequest): StoryboardPlan | null {
  if (typeof body !== 'object' || body === null) return null
  const { plan } = body as Record<string, unknown>
  return parseStoryboardPlan(plan, {
    shots: request.shots,
    totalSeconds: request.totalSeconds,
  })
}

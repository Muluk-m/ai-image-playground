import {
  parseStoryboardPlan,
  type StoryboardPlan,
  type StoryboardPlanRequest,
} from '@image-playground/shared'
import { authenticatedBffFetch } from './authClient'
import { bffBaseUrl } from './runtimeConfig'

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

const UNAVAILABLE = '分镜脚本没有生成成功'
/** BFF 的 504：模型没答完，不是这条路走不通——催一次通常就有了。 */
const TIMED_OUT = '分镜脚本生成超时，请重试'

export async function planStoryboard(
  request: StoryboardPlanRequest,
  fetcher: Fetcher = authenticatedBffFetch,
): Promise<StoryboardPlan> {
  const response = await fetcher(`${bffBaseUrl()}/api/storyboard/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (response.status === 504) throw new Error(TIMED_OUT)
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

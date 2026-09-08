import { type MatteResponse, parseMatteResponse } from '@image-playground/shared'
import { bffBaseUrl } from './runtimeConfig'

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

const UNAVAILABLE = '服务端抠图没有返回可用的蒙版'

export async function requestServerMatte(
  image: string,
  fetcher: Fetcher = fetch,
): Promise<MatteResponse> {
  const response = await fetcher(`${bffBaseUrl()}/api/matte`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image }),
  })
  const parsed = response.ok ? parseMatteResponse(await response.json()) : null
  if (!parsed) throw new Error(UNAVAILABLE)
  return parsed
}

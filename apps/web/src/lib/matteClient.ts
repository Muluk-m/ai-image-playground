import { type MatteResponse, parseMatteResponse } from '@image-playground/shared'
import { authenticatedBffFetch } from './authClient'
import { bffBaseUrl } from './runtimeConfig'

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

const UNAVAILABLE = '服务端抠图没有返回可用的蒙版'

export async function requestServerMatte(
  image: string,
  fetcher: Fetcher = authenticatedBffFetch,
): Promise<MatteResponse> {
  const endpoint = `${bffBaseUrl()}/api/matte`
  // HTTP-only LAN deployments may not expose Web Crypto; they retain the upload path.
  if (globalThis.crypto?.subtle) {
    const binary = atob(image.slice(image.indexOf(',') + 1))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    const probe = await fetcher(`${endpoint}/${hash}`, { cache: 'no-store' })
    if (probe.status !== 404) return parseResponse(probe)
  }
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image }),
  })
  return parseResponse(response)
}

async function parseResponse(response: Response): Promise<MatteResponse> {
  const parsed = response.ok ? parseMatteResponse(await response.json()) : null
  if (!parsed) throw new Error(UNAVAILABLE)
  return parsed
}

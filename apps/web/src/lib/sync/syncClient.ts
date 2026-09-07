import type { SyncRequestBody, SyncResponseBody } from '@image-playground/shared'
import { authenticatedBffFetch } from '../authClient'
import { bffBaseUrl } from '../runtimeConfig'

export class SyncRequestError extends Error {
  constructor(readonly status: number) {
    super(`sync_http_${status}`)
    this.name = 'SyncRequestError'
  }
}

/** `keepalive` 让页面隐藏时发出的请求活过卸载；浏览器给它的 body 上限是 64 KB。 */
export async function postSync(
  body: SyncRequestBody,
  options: { keepalive?: boolean } = {},
): Promise<SyncResponseBody> {
  const response = await authenticatedBffFetch(`${bffBaseUrl()}/api/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: options.keepalive,
  })
  if (!response.ok) throw new SyncRequestError(response.status)
  return (await response.json()) as SyncResponseBody
}

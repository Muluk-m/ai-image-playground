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

function assetImageUrl(imageId: string): string {
  return `${bffBaseUrl()}/api/sync/assets/${encodeURIComponent(imageId)}`
}

/** 服务端收下了这张图，还是永远不会收（配额、类型）——后者重试没有意义。 */
export type AssetImageUpload = 'uploaded' | 'refused'

export async function putAssetImage(imageId: string, blob: Blob): Promise<AssetImageUpload> {
  const response = await authenticatedBffFetch(assetImageUrl(imageId), {
    method: 'PUT',
    headers: { 'content-type': blob.type },
    body: blob,
  })
  if (response.ok) return 'uploaded'
  if (response.status === 413 || response.status === 415) return 'refused'
  throw new SyncRequestError(response.status)
}

/** 服务端也没有这张图时返回 null。 */
export async function getAssetImage(imageId: string): Promise<Blob | null> {
  const response = await authenticatedBffFetch(assetImageUrl(imageId))
  if (response.status === 404) return null
  if (!response.ok) throw new SyncRequestError(response.status)
  return await response.blob()
}

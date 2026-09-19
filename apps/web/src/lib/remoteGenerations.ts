import type { GenerationDetail } from '@image-playground/shared'
import { authenticatedBffFetch } from './authClient'
import { bffBaseUrl } from './runtimeConfig'

/** 云媒体引用：像素留在平台，文档里只存这个稳定身份（见 `lib/cloudMedia.ts`）。 */
export function mediaRef(mediaId: string): string {
  return `aip-media:${mediaId}`
}

/** 读一条平台生成的完整记录；读不到（含 404、离线）返回 null，调用方保持已有的卡不变。 */
export async function readRemoteGeneration(id: string): Promise<GenerationDetail | null> {
  try {
    const response = await authenticatedBffFetch(
      `${bffBaseUrl()}/api/generations/${encodeURIComponent(id)}`,
      { cache: 'no-store' },
    )
    if (!response.ok) return null
    return (await response.json()) as GenerationDetail
  } catch {
    return null
  }
}

/** 删平台上的生成记录。删成功（或它已经不在了）返回 true。 */
export async function deleteRemoteGeneration(id: string): Promise<boolean> {
  try {
    const response = await authenticatedBffFetch(
      `${bffBaseUrl()}/api/generations/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    )
    return response.ok || response.status === 404
  } catch {
    return false
  }
}

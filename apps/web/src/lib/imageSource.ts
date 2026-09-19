import { ensureImageCached, ensureImageThumbnailCached } from '../store'
import { mediaIdentity, resolveMediaSource } from './cloudMedia'

export interface ImagePreview {
  url: string
  width?: number
  height?: number
}

/** `aip-media:<uuid>` 形状的云媒体引用。 */
export function isMediaRef(ref: string): boolean {
  return mediaIdentity(ref) !== undefined
}

/**
 * 列表/卡片用的预览源（云媒体走 preview 变体）；读不到返回 null。
 *
 * 本机图的缩略图若还没生成，store 会在后台补，这里先返回 null——调用方要么
 * 渲染占位图，要么订阅 store 等它推回来（见 useImagePreview）。
 */
export async function loadImagePreview(ref: string): Promise<ImagePreview | null> {
  if (isMediaRef(ref)) {
    // 云媒体只给一个临时 URL，宽高得等 <img> 解码才知道，由调用方兜底。
    const url = await resolveMediaSource(ref, 'preview').catch(() => null)
    return url ? { url } : null
  }
  const thumbnail = await ensureImageThumbnailCached(ref).catch(() => undefined)
  if (!thumbnail) return null
  return { url: thumbnail.dataUrl, width: thumbnail.width, height: thumbnail.height }
}

/** 需要真实像素时用（下载、编辑、复用、送画布）；读不到返回 null。 */
export async function loadImageOriginal(ref: string): Promise<string | null> {
  if (isMediaRef(ref)) return await resolveMediaSource(ref, 'original').catch(() => null)
  return (await ensureImageCached(ref).catch(() => undefined)) ?? null
}

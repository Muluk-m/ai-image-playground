/**
 * 素材图的上下行。本机建的素材先把图片本体传上去，记录才推得动；别的设备建的素材
 * 等到真要看它、用它的那一刻才把图取回来，启动时一张都不取。
 */

import { assetStore } from '../../features/library/lib/assetStore'
import { blobToDataUrl, refreshImageThumbnail } from '../../store'
import { getImage, hasImage, putImage } from '../db'
import { clearImageUnsynced, markImageUnsynced, restoreImagelessAssets } from './pending'
import { useSyncStatus } from './status'
import { getAssetImage, putAssetImage } from './syncClient'

/**
 * `refused` = 服务端不会再收这张图，记录改标「未同步」；`failed` 留着下一轮重试；
 * `imageless` = 本机没有图片本体，这一轮推不动这条记录。
 */
export type AssetImageUpload = 'uploaded' | 'refused' | 'failed' | 'imageless'

const uploaded = new Set<string>()
const uploads = new Map<string, Promise<AssetImageUpload>>()
const fetches = new Map<string, Promise<boolean>>()
/** 取图排队串行，否则打开素材库会把几十张图一起拉下来。 */
let fetchQueue: Promise<unknown> = Promise.resolve()

/** 引擎启动时清账：`imageId` 是内容哈希，换个账号登录后同一张图仍要重新上传一次。 */
export function forgetUploadedAssetImages(): void {
  uploaded.clear()
}

/** 页面隐藏时的冲刷靠它挑记录：这一刻传得动的只有服务端已经拿到的那些图。 */
export function isAssetImageOnServer(imageId: string): boolean {
  return uploaded.has(imageId)
}

/** 服务端回传过的素材图它自己就有；不记下来，改个名就会把整张图重传一遍。 */
export function noteAssetImageOnServer(imageId: string): void {
  uploaded.add(imageId)
}

export function uploadAssetImage(imageId: string): Promise<AssetImageUpload> {
  if (uploaded.has(imageId)) return Promise.resolve('uploaded')
  const running = uploads.get(imageId)
  if (running) return running
  const task = upload(imageId).finally(() => uploads.delete(imageId))
  uploads.set(imageId, task)
  return task
}

/** 本机有图片本体就直接算数；没有才去服务端取一张回来。 */
export function ensureAssetImage(imageId: string): Promise<boolean> {
  const running = fetches.get(imageId)
  if (running) return running
  const task = fetchQueue.then(() => fetchIfMissing(imageId)).finally(() => fetches.delete(imageId))
  fetchQueue = task
  fetches.set(imageId, task)
  return task
}

async function upload(imageId: string): Promise<AssetImageUpload> {
  try {
    const image = await getImage(imageId)
    const blob = image && toBlob(image.dataUrl)
    if (!blob) return 'imageless'

    if ((await putAssetImage(imageId, blob)) === 'refused') {
      markImageUnsynced(imageId)
      return 'refused'
    }
  } catch {
    return 'failed'
  }
  noteAssetImageOnServer(imageId)
  clearImageUnsynced(imageId)
  return 'uploaded'
}

async function fetchIfMissing(imageId: string): Promise<boolean> {
  try {
    if (await hasImage(imageId)) return true
    if (!useSyncStatus.getState().enabled) return false
    // 服务端只存素材图；任务结果、商品图这些本机数据的缺图不该去问它。
    const named = await assetsNaming(imageId)
    if (named.length === 0) return false

    const blob = await getAssetImage(imageId)
    if (!blob) return false
    await putImage({
      id: imageId,
      dataUrl: await blobToDataUrl(blob),
      createdAt: Date.now(),
      source: 'upload',
    })
    refreshImageThumbnail(imageId)
    noteAssetImageOnServer(imageId)
    restoreImagelessAssets(named)
    return true
  } catch {
    return false
  }
}

async function assetsNaming(imageId: string): Promise<string[]> {
  const assets = await assetStore.list()
  return assets.filter((asset) => asset.imageId === imageId).map((asset) => asset.id)
}

function toBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) return null
  const binary = atob(match[2]!)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: match[1]! })
}

/// <reference lib="es2021.weakref" />
/**
 * fileId → HTMLImageElement 缓存：画布渲染与离屏导出共用同一份解码位图。
 * dataUrl 解码是异步的；渲染侧用 getLoaded 同步取（未就绪返回 null 并触发加载），
 * 导出侧用 load await 确保位图就绪。
 */

import { scopedStorageName } from '../../../lib/authScope'
import { mediaIdentity, resolveMediaSource } from '../../../lib/cloudMedia'

const loaded = new Map<string, HTMLImageElement>()
const cloudLoaded = new Map<string, WeakRef<HTMLImageElement>>()
const loading = new Map<string, Promise<HTMLImageElement>>()

export function loadImage(fileId: string, dataUrl: string): Promise<HTMLImageElement> {
  return load(fileId, dataUrl, 'original')
}

function cacheKey(fileId: string, source: string, variant: 'original' | 'preview') {
  return mediaIdentity(source)
    ? `${scopedStorageName('canvas-image')}:${source}:${variant}`
    : fileId
}

function load(
  fileId: string,
  dataUrl: string,
  variant: 'original' | 'preview',
): Promise<HTMLImageElement> {
  const key = cacheKey(fileId, dataUrl, variant)
  const hit = cloudLoaded.get(key)?.deref() ?? loaded.get(key)
  if (hit) return Promise.resolve(hit)
  const pending = loading.get(key)
  if (pending) return pending
  const promise = resolveMediaSource(dataUrl, variant)
    .then(
      (source) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image()
          img.onload = () => {
            if (!mediaIdentity(dataUrl)) loaded.set(key, img)
            else if (variant === 'preview') {
              cloudLoaded.set(key, new WeakRef(img))
              if (cloudLoaded.size > 2048) cloudLoaded.delete(cloudLoaded.keys().next().value!)
            }
            resolve(img)
          }
          img.onerror = (err) => {
            reject(err)
          }
          img.src = source
        }),
    )
    .finally(() => loading.delete(key))
  loading.set(key, promise)
  return promise
}

/** 同步取已解码位图；未就绪则触发加载并通过 onReady 通知（渲染侧重绘）。 */
export function getLoadedImage(
  fileId: string,
  dataUrl: string | undefined,
  onReady?: () => void,
): HTMLImageElement | null {
  const key = dataUrl ? cacheKey(fileId, dataUrl, 'preview') : fileId
  const hit = cloudLoaded.get(key)?.deref() ?? loaded.get(key)
  if (hit) return hit
  if (dataUrl) {
    load(fileId, dataUrl, 'preview').then(
      () => onReady?.(),
      () => {},
    )
  }
  return null
}

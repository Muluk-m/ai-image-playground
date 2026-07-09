/**
 * fileId → HTMLImageElement 缓存：画布渲染与离屏导出共用同一份解码位图。
 * dataUrl 解码是异步的；渲染侧用 getLoaded 同步取（未就绪返回 null 并触发加载），
 * 导出侧用 load await 确保位图就绪。
 */

const loaded = new Map<string, HTMLImageElement>()
const loading = new Map<string, Promise<HTMLImageElement>>()

export function loadImage(fileId: string, dataUrl: string): Promise<HTMLImageElement> {
  const hit = loaded.get(fileId)
  if (hit) return Promise.resolve(hit)
  const pending = loading.get(fileId)
  if (pending) return pending
  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      loaded.set(fileId, img)
      loading.delete(fileId)
      resolve(img)
    }
    img.onerror = (err) => {
      loading.delete(fileId)
      reject(err)
    }
    img.src = dataUrl
  })
  loading.set(fileId, promise)
  return promise
}

/** 同步取已解码位图；未就绪则触发加载并通过 onReady 通知（渲染侧重绘）。 */
export function getLoadedImage(
  fileId: string,
  dataUrl: string | undefined,
  onReady?: () => void,
): HTMLImageElement | null {
  const hit = loaded.get(fileId)
  if (hit) return hit
  if (dataUrl) {
    loadImage(fileId, dataUrl).then(
      () => onReady?.(),
      () => {},
    )
  }
  return null
}

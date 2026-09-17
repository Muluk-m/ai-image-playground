import { captureVideoFrame } from '../../video/lib/playback'

/** 上游慢或跨域没配好时，抓封面不该把整次落画布拖住。 */
const CAPTURE_TIMEOUT_MS = 30_000
const FALLBACK_WIDTH = 640
const FALLBACK_HEIGHT = 360
const FALLBACK_FILL = '#17171a'

/** 取不到首帧时的深色底：视频仍然点得开，只是没有封面。 */
export function blankVideoPoster(size: {
  readonly width?: number
  readonly height?: number
}): string {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(size.width ?? FALLBACK_WIDTH))
  canvas.height = Math.max(1, Math.round(size.height ?? FALLBACK_HEIGHT))
  const context = canvas.getContext('2d')
  if (context) {
    context.fillStyle = FALLBACK_FILL
    context.fillRect(0, 0, canvas.width, canvas.height)
  }
  return canvas.toDataURL('image/png')
}

/** 抓视频首帧当封面：抓不到、或上游慢到超时都返回 null，不该把调用方拖住。 */
export function captureVideoPoster(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    const listeners = new AbortController()
    let settled = false
    const settle = (poster: string | null) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      listeners.abort()
      video.removeAttribute('src')
      // 只摘 src 不会中止在途请求，超时那条路上它会一直挂到 GC。
      video.load()
      resolve(poster)
    }
    const timer = window.setTimeout(() => settle(null), CAPTURE_TIMEOUT_MS)
    video.crossOrigin = 'use-credentials'
    video.preload = 'auto'
    video.muted = true
    video.addEventListener(
      'loadeddata',
      () => {
        if (!settled) settle(captureVideoFrame(video))
      },
      { signal: listeners.signal },
    )
    video.addEventListener('error', () => settle(null), { signal: listeners.signal })
    video.src = url
    video.load()
  })
}

/** Only replace the exact legacy solid placeholder, never a user's real cover. */
export function isBlankVideoPoster(source: string): Promise<boolean> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onerror = () => resolve(false)
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 4
        const ctx = canvas.getContext('2d')
        if (!ctx) return resolve(false)
        ctx.drawImage(image, 0, 0, 4, 4)
        const pixels = ctx.getImageData(0, 0, 4, 4).data
        resolve(pixels.every((value, index) => value === [23, 23, 26, 255][index % 4]))
      } catch {
        resolve(false)
      }
    }
    image.src = source
  })
}

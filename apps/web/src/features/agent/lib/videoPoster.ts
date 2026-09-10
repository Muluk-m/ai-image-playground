import { captureVideoFrame } from '../../video/lib/playback'

/** 上游慢或跨域没配好时，抓封面不该把整次落画布拖住。 */
const CAPTURE_TIMEOUT_MS = 8_000
const FALLBACK_WIDTH = 640
const FALLBACK_HEIGHT = 360
const FALLBACK_FILL = '#17171a'

function blankPoster(width: number, height: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const context = canvas.getContext('2d')
  if (context) {
    context.fillStyle = FALLBACK_FILL
    context.fillRect(0, 0, canvas.width, canvas.height)
  }
  return canvas.toDataURL('image/png')
}

function captureFirstFrame(url: string): Promise<string | null> {
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
    video.preload = 'metadata'
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
  })
}

/** 画布上的视频对象是一张封面加一个播放地址；取不到首帧就给深色底，仍然点得开。 */
export async function videoPosterDataUrl(
  url: string,
  size: { readonly width?: number; readonly height?: number },
): Promise<string> {
  const captured = await captureFirstFrame(url)
  return captured ?? blankPoster(size.width ?? FALLBACK_WIDTH, size.height ?? FALLBACK_HEIGHT)
}

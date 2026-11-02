/** 连续这么久一个字节都没发出去，就当这次直传卡死：断开，交给上层按超时重试（BUG-38）。 */
export const MEDIA_PUT_STALL_MS = 60_000

export interface MediaPutOptions {
  signal: AbortSignal
  /** 已发出的比例，0–1；浏览器给不出总量时不回调。 */
  onProgress?: (fraction: number) => void
  stallMs?: number
}

/**
 * 直传对象存储的那一次 PUT。用 XHR 而不是 fetch：浏览器里 fetch 拿不到请求体的发送进度，
 * 只能在整段超时后才知道卡住了。返回值只带上层要看的状态码。
 * 卡住抛 `TimeoutError`、断网抛 `TypeError`，和原来 fetch 的失败形状一致，重试判定不用改。
 */
export function putMedia(
  url: string,
  body: ArrayBuffer,
  contentType: string,
  options: MediaPutOptions,
): Promise<{ ok: boolean; status: number }> {
  const { signal, onProgress } = options
  const stallMs = options.stallMs ?? MEDIA_PUT_STALL_MS
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const settle = (finish: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      finish()
    }
    const stop = (error: unknown) =>
      settle(() => {
        xhr.abort()
        reject(error)
      })
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(
        () => stop(new DOMException('media upload stalled', 'TimeoutError')),
        stallMs,
      )
    }
    const aborted = () => stop(signal.reason)
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    signal.addEventListener('abort', aborted, { once: true })
    xhr.open('PUT', url)
    xhr.withCredentials = false
    xhr.setRequestHeader('content-type', contentType)
    xhr.upload.onprogress = (event) => {
      arm()
      if (event.lengthComputable && event.total > 0)
        onProgress?.(Math.min(1, event.loaded / event.total))
    }
    // 请求体发完到响应回来这段也算在卡死判定里；响应在走就续上。
    xhr.onprogress = arm
    xhr.onload = () =>
      settle(() => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status }))
    xhr.onerror = () => settle(() => reject(new TypeError('Failed to fetch')))
    xhr.onabort = () => settle(() => reject(new DOMException('media upload aborted', 'AbortError')))
    arm()
    xhr.send(body)
  })
}

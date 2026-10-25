import { accountScope } from './authScope'

class DownloadRequestError extends Error {
  constructor(readonly status: number) {
    super('download_request_failed')
  }
}

/** Retry only byte retrieval; the caller must trigger the browser download exactly once. */
export async function fetchDownloadBlob(
  url: string,
  options: Pick<RequestInit, 'credentials' | 'signal'> = {},
  onStage?: (stage: 'fetch' | 'blob') => void,
): Promise<Blob> {
  const sameAccount = accountScope()
  const deadline = new AbortController()
  const timer = setTimeout(
    () => deadline.abort(new DOMException('Download timed out', 'TimeoutError')),
    300_000,
  )
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal
  const current = () => {
    signal.throwIfAborted()
    if (!sameAccount()) throw new DOMException('Account changed', 'AbortError')
  }
  try {
    for (let attempt = 0; ; attempt++) {
      current()
      onStage?.('fetch')
      try {
        const response = await fetch(url, { ...options, signal })
        current()
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          throw new DownloadRequestError(response.status)
        }
        onStage?.('blob')
        const blob = await response.blob()
        current()
        return blob
      } catch (error) {
        current()
        const transient = error instanceof DownloadRequestError
          ? [408, 429, 500, 502, 503, 504].includes(error.status)
          : error instanceof TypeError || (error instanceof DOMException &&
            (error.name === 'AbortError' || error.name === 'TimeoutError'))
        if (!transient || attempt >= 2) throw error
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(delay)
            signal.removeEventListener('abort', abort)
            reject(signal.reason)
          }
          const delay = setTimeout(() => {
            signal.removeEventListener('abort', abort)
            resolve()
          }, 500 * 2 ** attempt)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

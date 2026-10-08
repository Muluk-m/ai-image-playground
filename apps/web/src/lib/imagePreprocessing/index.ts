import { IMAGE_PREPROCESSING, type ImagePreparationLimits, type PreparedImage } from './policy'
import { prepareImage } from './prepare'

export { IMAGE_PREPROCESSING } from './policy'

// All intake paths share one decoder slot, including the inline compatibility path.
let queue = Promise.resolve()
export function preprocessImageFile(
  file: File,
  limits: ImagePreparationLimits = {
    maxBytes: IMAGE_PREPROCESSING.maxBytes,
    maxPixels: IMAGE_PREPROCESSING.maxPixels,
  },
  signal?: AbortSignal,
): Promise<PreparedImage> {
  const result = queue.then(async () => {
    signal?.throwIfAborted()
    if (file.size > IMAGE_PREPROCESSING.maxInputBytes) throw new Error('attachment_input_too_large')
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(
      () => controller.abort(new Error('attachment_compression_timeout')),
      IMAGE_PREPROCESSING.timeoutMs,
    )
    const processing = controller.signal
    try {
      const data = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader()
        const abortRead = () => reader.abort()
        const done = () => processing.removeEventListener('abort', abortRead)
        reader.onload = () => {
          done()
          resolve(reader.result as ArrayBuffer)
        }
        reader.onerror = () => {
          done()
          reject(new Error('attachment_read_failed'))
        }
        reader.onabort = () => {
          done()
          reject(processing.reason)
        }
        processing.addEventListener('abort', abortRead, { once: true })
        reader.readAsArrayBuffer(file)
      })
      processing.throwIfAborted()
      if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined')
        return await prepareImage(data, limits, () => processing.throwIfAborted(), processing)
      return await new Promise<PreparedImage>((resolve, reject) => {
        let worker: Worker
        try {
          worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
        } catch {
          reject(new Error('attachment_compression_failed'))
          return
        }
        const finish = () => {
          processing.removeEventListener('abort', abortWorker)
          worker.terminate()
        }
        const abortWorker = () => {
          finish()
          reject(processing.reason)
        }
        processing.addEventListener('abort', abortWorker, { once: true })
        worker.onmessage = ({
          data: result,
        }: MessageEvent<{ image?: PreparedImage; errorCode?: string }>) => {
          finish()
          if (result.image) resolve(result.image)
          else reject(new Error(result.errorCode ?? 'attachment_compression_failed'))
        }
        const fail = () => {
          finish()
          reject(new Error('attachment_compression_failed'))
        }
        worker.onerror = fail
        worker.onmessageerror = fail
        try {
          worker.postMessage({ data, limits }, [data])
        } catch {
          fail()
        }
      })
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
  })
  queue = result.then(
    () => {},
    () => {},
  )
  return result
}

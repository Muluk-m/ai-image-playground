import { inspectImage } from './header'
import {
  IMAGE_PREPROCESSING,
  type ImagePreparationLimits,
  type PreparedImage,
  preparedDimensions,
} from './policy'

type Surface = OffscreenCanvas | HTMLCanvasElement
function surface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}
function encode(canvas: Surface, type: string, quality?: number): Promise<Blob> {
  return 'convertToBlob' in canvas
    ? canvas.convertToBlob({ type, quality })
    : new Promise((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('attachment_compression_failed'))),
          type,
          quality,
        ),
      )
}
function cancellable<T>(work: Promise<T>, signal?: AbortSignal, cancel?: () => void): Promise<T> {
  if (!signal) return work
  return new Promise((resolve, reject) => {
    const abort = () => {
      cancel?.()
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
    if (signal.aborted) abort()
  })
}
async function decode(
  blob: Blob,
  signal?: AbortSignal,
): Promise<{
  image: CanvasImageSource
  width: number
  height: number
  close: () => void
}> {
  // The Worker can be terminated. On the main-thread fallback, an Image's source can be cancelled.
  if (!signal && typeof createImageBitmap === 'function') {
    const image = await createImageBitmap(blob, { imageOrientation: 'from-image' })
    return { image, width: image.width, height: image.height, close: () => image.close() }
  }
  const url = URL.createObjectURL(blob)
  const image = new Image()
  const close = () => {
    image.src = ''
    URL.revokeObjectURL(url)
  }
  try {
    image.src = url
    await cancellable(image.decode(), signal, close)
    return { image, width: image.naturalWidth, height: image.naturalHeight, close }
  } catch (error) {
    close()
    throw error
  }
}

export async function prepareImage(
  data: ArrayBuffer,
  limits: ImagePreparationLimits,
  check: () => void = () => {},
  signal?: AbortSignal,
): Promise<PreparedImage> {
  check()
  if (data.byteLength > IMAGE_PREPROCESSING.maxInputBytes)
    throw new Error('attachment_input_too_large')
  const header = inspectImage(data)
  // JPEG exporters may append metadata after EOI. Decode and retain only the encoded image.
  const encodedImage = new Uint8Array(data, 0, header.dataEnd)
  let decoded: Awaited<ReturnType<typeof decode>>
  try {
    decoded = await decode(new Blob([encodedImage], { type: header.contentType }), signal)
  } catch {
    signal?.throwIfAborted()
    throw new Error('media_invalid_image')
  }
  let closed = false
  const release = () => {
    if (!closed) {
      decoded.close()
      closed = true
    }
  }
  let canvas: Surface | undefined
  try {
    check()
    const originalWidth = decoded.width
    const originalHeight = decoded.height
    if (
      originalWidth * originalHeight > IMAGE_PREPROCESSING.maxDecodePixels ||
      Math.max(originalWidth, originalHeight) > IMAGE_PREPROCESSING.maxDecodeSide
    )
      throw new Error('attachment_decode_limit')
    // EXIF orientation may swap the axes; derive the output from the actual oriented bitmap.
    let { width, height } = preparedDimensions(originalWidth, originalHeight, limits)
    const maxBytes = Math.min(limits.maxBytes, IMAGE_PREPROCESSING.maxBytes)
    canvas = surface(width, height)
    const ctx = canvas.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null
    if (!ctx) throw new Error('attachment_compression_failed')
    ctx.drawImage(decoded.image, 0, 0, width, height)
    release()
    let alpha = false
    if (header.contentType !== 'image/jpeg') {
      const pixels = ctx.getImageData(0, 0, width, height).data
      for (let at = 3; at < pixels.length; at += 4) {
        if (pixels[at] !== 255) {
          alpha = true
          break
        }
      }
    }
    for (;;) {
      check()
      let candidate: Blob | undefined
      if (header.contentType !== 'image/jpeg') {
        const png = await cancellable(encode(canvas, 'image/png'), signal)
        if (png.size <= maxBytes) candidate = png
      }
      for (const quality of IMAGE_PREPROCESSING.qualitySteps) {
        check()
        const encoded = await cancellable(
          encode(canvas, alpha ? 'image/webp' : 'image/jpeg', quality),
          signal,
        )
        // Some browsers silently use PNG when a requested encoder is unavailable.
        if (alpha && encoded.type !== 'image/webp') break
        if (encoded.size <= maxBytes) {
          if (!candidate || encoded.size < candidate.size) candidate = encoded
          break
        }
      }
      if (candidate) {
        // A validated, already-small original is useful; re-encoding must never inflate it.
        if (
          width === originalWidth &&
          height === originalHeight &&
          encodedImage.byteLength <= candidate.size &&
          encodedImage.byteLength <= maxBytes
        )
          return {
            data: header.dataEnd === data.byteLength ? data : data.slice(0, header.dataEnd),
            contentType: header.contentType,
            width,
            height,
            originalBytes: data.byteLength,
          }
        return {
          data: await candidate.arrayBuffer(),
          contentType: candidate.type,
          width,
          height,
          originalBytes: data.byteLength,
        }
      }
      if (Math.max(width, height) <= IMAGE_PREPROCESSING.minEdge)
        throw new Error('attachment_compression_failed')
      const nextWidth = Math.max(1, Math.floor(width * 0.75))
      const nextHeight = Math.max(1, Math.floor(height * 0.75))
      const next = surface(nextWidth, nextHeight)
      const nextCtx = next.getContext('2d') as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null
      if (!nextCtx) throw new Error('attachment_compression_failed')
      nextCtx.drawImage(canvas, 0, 0, nextWidth, nextHeight)
      canvas.width = canvas.height = 0
      canvas = next
      width = nextWidth
      height = nextHeight
    }
  } finally {
    release()
    if (canvas) canvas.width = canvas.height = 0
  }
}

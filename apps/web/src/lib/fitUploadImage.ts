import { MAX_IMAGE_UPLOAD_BYTES } from '@image-playground/shared'
import { calculateFitSize, canvasToBlob } from './canvasImage'
import { inspectImage } from './imagePreprocessing/header'
import { IMAGE_PREPROCESSING } from './imagePreprocessing/policy'

/** 超过这道才在上传前压缩。更小的图保持原件，坏图仍走原来的拒绝。 */
export const UPLOAD_COMPRESSION_THRESHOLD_BYTES = MAX_IMAGE_UPLOAD_BYTES

const START_EDGE = 4096
const MIN_EDGE = 256
const JPEG_QUALITIES = [0.92, 0.85, 0.75, 0.65] as const
const WEBP_QUALITIES = [0.9, 0.8] as const

export interface FittedUploadFile {
  file: File
  compressed: boolean
}

interface DecodedImage {
  source: CanvasImageSource
  width: number
  height: number
  close: () => void
}

let gate: Promise<void> = Promise.resolve()

/** 解码和编码串行，避免好几张大图同时把位图铺在内存里。 */
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = gate.then(work, work)
  gate = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function edgePlan(width: number, height: number): number[] {
  const longest = Math.max(width, height, 1)
  const edges: number[] = []
  let edge = Math.min(longest, START_EDGE)
  while (edge >= MIN_EDGE) {
    edges.push(Math.round(edge))
    const next = Math.floor(edge * 0.75)
    if (next >= edge) break
    edge = next
  }
  if (edges.length === 0) edges.push(MIN_EDGE)
  return edges
}

function namedFile(original: File, blob: Blob, type: string): File {
  const actual = blob.type || type
  const extension = actual === 'image/png' ? 'png' : actual === 'image/webp' ? 'webp' : 'jpg'
  const stem = original.name.replace(/\.[^.]+$/i, '') || 'image'
  return new File([blob], `${stem}.${extension}`, {
    type: actual,
    lastModified: original.lastModified,
  })
}

function bitmapDecoded(image: ImageBitmap): DecodedImage {
  return {
    source: image,
    width: image.width,
    height: image.height,
    close: () => image.close(),
  }
}

async function decodeWithImage(blob: Blob): Promise<DecodedImage> {
  const url = URL.createObjectURL(blob)
  const image = new Image()
  const close = () => {
    image.src = ''
    URL.revokeObjectURL(url)
  }
  try {
    image.src = url
    if (typeof image.decode === 'function') await image.decode()
    else {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error('media_invalid_image'))
      })
    }
    if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) throw new Error('media_invalid_image')
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close }
  } catch (error) {
    close()
    throw error
  }
}

async function decodeImage(blob: Blob): Promise<DecodedImage | undefined> {
  if (typeof createImageBitmap === 'function') {
    try {
      return bitmapDecoded(await createImageBitmap(blob, { imageOrientation: 'from-image' }))
    } catch {
      try {
        return bitmapDecoded(await createImageBitmap(blob))
      } catch {
        // 浏览器解不了这份字节时再试 Image，仍失败就交给原来的报错。
      }
    }
  }
  try {
    return await decodeWithImage(blob)
  } catch {
    return undefined
  }
}

/** 分块看透明通道：每块最多 512²，细线也不会被缩小采样漏掉。 */
const ALPHA_TILE = 512

function sourceIsOpaque(source: CanvasImageSource, width: number, height: number): boolean {
  const probe = document.createElement('canvas')
  const ctx = probe.getContext('2d', { willReadFrequently: true })
  if (!ctx) return false
  try {
    for (let y = 0; y < height; y += ALPHA_TILE) {
      const tileHeight = Math.min(ALPHA_TILE, height - y)
      for (let x = 0; x < width; x += ALPHA_TILE) {
        const tileWidth = Math.min(ALPHA_TILE, width - x)
        probe.width = tileWidth
        probe.height = tileHeight
        ctx.drawImage(source, x, y, tileWidth, tileHeight, 0, 0, tileWidth, tileHeight)
        const { data } = ctx.getImageData(0, 0, tileWidth, tileHeight)
        for (let index = 3; index < data.length; index += 4) {
          if (data[index] !== 255) return false
        }
      }
    }
    return true
  } finally {
    probe.width = 0
    probe.height = 0
  }
}

async function encodeUnderLimit(
  canvas: HTMLCanvasElement,
  opaque: boolean,
  limit: number,
): Promise<FileBlob | undefined> {
  if (opaque) {
    for (const quality of JPEG_QUALITIES) {
      const blob = await canvasToBlob(canvas, 'image/jpeg', quality).catch(() => undefined)
      if (blob && blob.size > 0 && blob.size <= limit) return { blob, type: 'image/jpeg' }
    }
    return undefined
  }
  const png = await canvasToBlob(canvas, 'image/png').catch(() => undefined)
  if (png && png.size > 0 && png.size <= limit) return { blob: png, type: 'image/png' }
  for (const quality of WEBP_QUALITIES) {
    const webp = await canvasToBlob(canvas, 'image/webp', quality).catch(() => undefined)
    if (!webp || webp.size <= 0 || webp.size > limit) continue
    if (webp.type && webp.type !== 'image/webp' && webp.type !== 'image/png') continue
    return { blob: webp, type: webp.type || 'image/webp' }
  }
  return undefined
}

interface FileBlob {
  blob: Blob
  type: string
}

/**
 * 已知容器坏了、是动图、或像素超出本机解码安全线时不硬解，调用方继续走原来的拒绝。
 * 认不出的格式（BMP、SVG 等）仍交给浏览器试一次，解得开就转码。
 */
function isGif(type: string, bytes: ArrayBuffer): boolean {
  if (type === 'image/gif') return true
  if (bytes.byteLength < 6) return false
  const sig = String.fromCharCode(...new Uint8Array(bytes, 0, 6))
  return sig === 'GIF87a' || sig === 'GIF89a'
}

function admitsDecode(bytes: ArrayBuffer): boolean {
  try {
    const header = inspectImage(bytes)
    const pixels = header.width * header.height
    return (
      pixels > 0 &&
      pixels <= IMAGE_PREPROCESSING.maxDecodePixels &&
      Math.max(header.width, header.height) <= IMAGE_PREPROCESSING.maxDecodeSide
    )
  } catch (error) {
    return error instanceof Error && error.message === 'media_unsupported_image'
  }
}

function readFileBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error ?? new Error('attachment_read_failed'))
    reader.readAsArrayBuffer(file)
  })
}

async function compressOverLimit(file: File, limit: number): Promise<FittedUploadFile> {
  const unchanged = { file, compressed: false as const }
  let bytes: ArrayBuffer
  try {
    bytes = await readFileBytes(file)
  } catch {
    return unchanged
  }
  if (isGif(file.type, bytes) || !admitsDecode(bytes)) return unchanged
  const decoded = await decodeImage(
    new Blob([bytes], { type: file.type || 'application/octet-stream' }),
  )
  if (!decoded || !(decoded.width > 0 && decoded.height > 0)) return unchanged
  const canvas = document.createElement('canvas')
  const opaque =
    /^image\/jpe?g$/i.test(file.type) ||
    sourceIsOpaque(decoded.source, decoded.width, decoded.height)
  try {
    const ctx = canvas.getContext('2d')
    if (!ctx) return unchanged
    for (const edge of edgePlan(decoded.width, decoded.height)) {
      const { width, height } = calculateFitSize(decoded.width, decoded.height, edge)
      canvas.width = width
      canvas.height = height
      ctx.drawImage(decoded.source, 0, 0, width, height)
      const encoded = await encodeUnderLimit(canvas, opaque, limit)
      if (encoded) return { file: namedFile(file, encoded.blob, encoded.type), compressed: true }
    }
    return unchanged
  } catch {
    return unchanged
  } finally {
    decoded.close()
    canvas.width = 0
    canvas.height = 0
  }
}

/**
 * 只处理超过 50 MB 的图片。`targetBytes` 只把这些大图的结果再收紧，
 * 不把 50 MB 以下的原件拿去重编码。解不开、动图、或怎么压都还是超限时交还原文件。
 */
export function fitUploadImageFile(
  file: File,
  targetBytes = UPLOAD_COMPRESSION_THRESHOLD_BYTES,
): Promise<FittedUploadFile> {
  const limit = Math.min(UPLOAD_COMPRESSION_THRESHOLD_BYTES, Math.max(1, targetBytes))
  if (
    !file.type.startsWith('image/') ||
    file.size <= UPLOAD_COMPRESSION_THRESHOLD_BYTES ||
    file.size > IMAGE_PREPROCESSING.maxInputBytes
  ) {
    return Promise.resolve({ file, compressed: false })
  }
  return exclusive(() => compressOverLimit(file, limit))
}

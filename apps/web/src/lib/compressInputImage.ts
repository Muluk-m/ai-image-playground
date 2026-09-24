import { calculateFitSize, loadImage } from './canvasImage'
import { getDataUrlDecodedByteSize } from './imageApiShared'

const MAX_EDGE = 2048
const JPEG_QUALITY = 0.85
const PASSTHROUGH_BYTES = 256 * 1024

/** JPEG 是唯一保证不含 alpha 的容器，其余格式必须扫过像素才敢编码成 JPEG。 */
const OPAQUE_MIME = /^data:image\/jpe?g/i
/** 上游只认这几种；AVIF / HEIC / BMP 之类再小也要重编码，否则送出去就是「不是有效图片」。 */
const UPSTREAM_MIME = /^data:image\/(jpe?g|png|gif|webp)[;,]/i

/** 部分画布来源把 ICO / WebP 标成 PNG；仅看 data URL 头会把小图直接放行。 */
function hasMatchingImageSignature(dataUrl: string): boolean {
  const match = /^data:image\/(jpe?g|png|gif|webp);base64,([a-z0-9+/]{16,})/i.exec(dataUrl)
  if (!match) return false
  let header: string
  try {
    header = atob(match[2]!.slice(0, 32))
  } catch {
    return false
  }
  const mime = match[1]!.toLowerCase()
  if (mime === 'jpeg' || mime === 'jpg') return header.startsWith('\xff\xd8\xff')
  if (mime === 'png') return header.startsWith('\x89PNG\r\n\x1a\n')
  if (mime === 'gif') return header.startsWith('GIF87a') || header.startsWith('GIF89a')
  return header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP'
}

function hasAlphaPixels(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  const { data } = ctx.getImageData(0, 0, width, height)
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return true
  }
  return false
}

/** 压缩失败一律回退原图，不因此拦掉一次提交。 */
async function compressOne(dataUrl: string): Promise<string> {
  const originalBytes = getDataUrlDecodedByteSize(dataUrl)
  const foreign = !UPSTREAM_MIME.test(dataUrl) || !hasMatchingImageSignature(dataUrl)
  if (originalBytes <= PASSTHROUGH_BYTES && !foreign) return dataUrl

  try {
    const image = await loadImage(dataUrl)
    const { width, height } = calculateFitSize(image.naturalWidth, image.naturalHeight, MAX_EDGE)

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return dataUrl
    ctx.drawImage(image, 0, 0, width, height)

    const keepAlpha = (foreign || !OPAQUE_MIME.test(dataUrl)) && hasAlphaPixels(ctx, width, height)
    const compressed = keepAlpha
      ? canvas.toDataURL('image/png')
      : canvas.toDataURL('image/jpeg', JPEG_QUALITY)

    return foreign || getDataUrlDecodedByteSize(compressed) < originalBytes ? compressed : dataUrl
  } catch {
    return dataUrl
  }
}

/**
 * 串行：编码本来就是同步的主线程活，并行只会把整幅位图的内存峰值乘上图片张数。
 */
export async function compressInputImageDataUrls(dataUrls: readonly string[]): Promise<string[]> {
  const compressed: string[] = []
  for (const dataUrl of dataUrls) {
    compressed.push(await compressOne(dataUrl))
  }
  return compressed
}

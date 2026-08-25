import { calculateFitSize, loadImage } from './canvasImage'
import { getDataUrlDecodedByteSize } from './imageApiShared'

const MAX_EDGE = 2048
const JPEG_QUALITY = 0.85
const PASSTHROUGH_BYTES = 256 * 1024

/** JPEG 是唯一保证不含 alpha 的容器，其余格式必须扫过像素才敢编码成 JPEG。 */
const OPAQUE_MIME = /^data:image\/jpe?g/i

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
  if (originalBytes <= PASSTHROUGH_BYTES) return dataUrl

  try {
    const image = await loadImage(dataUrl)
    const { width, height } = calculateFitSize(image.naturalWidth, image.naturalHeight, MAX_EDGE)

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return dataUrl
    ctx.drawImage(image, 0, 0, width, height)

    const keepAlpha = !OPAQUE_MIME.test(dataUrl) && hasAlphaPixels(ctx, width, height)
    const compressed = keepAlpha
      ? canvas.toDataURL('image/png')
      : canvas.toDataURL('image/jpeg', JPEG_QUALITY)

    return getDataUrlDecodedByteSize(compressed) < originalBytes ? compressed : dataUrl
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

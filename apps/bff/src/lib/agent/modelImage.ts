import sharp from 'sharp'

/** 对话模型与生图上游只认这几种位图；其余（SVG、AVIF、HEIC、TIFF、BMP…）先转成 PNG。 */
export const MODEL_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

function parseDataUrl(value: string): { mime: string; bytes: Buffer } | null {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(value)
  return match ? { mime: match[1]!.toLowerCase(), bytes: Buffer.from(match[2]!, 'base64') } : null
}

/**
 * 把一张参考图变成上游接受的格式。画布可存 SVG，用户也能拖进 AVIF / HEIC；
 * 上游对这些一律回「不是有效图片」。转换失败（sharp 不认的格式）保留原图，
 * 让上游报它自己的错，而不是在这里吞掉整轮。
 */
export async function toModelImageDataUrl(dataUrl: string): Promise<string> {
  const parsed = parseDataUrl(dataUrl)
  if (!parsed || MODEL_IMAGE_MIMES.has(parsed.mime)) return dataUrl
  try {
    const png = await sharp(parsed.bytes).png().toBuffer()
    return `data:image/png;base64,${png.toString('base64')}`
  } catch {
    return dataUrl
  }
}

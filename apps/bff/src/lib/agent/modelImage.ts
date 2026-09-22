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

/**
 * 预览的规格只写在这里。上传时 `projectMedia` 按它生成 `preview_key` 落库，读时对没有预留
 * 预览的来源（工具产物、素材、本轮附图）按同一条现算——两处各缩各的，模型看到的「预览」
 * 就会随来源而变。
 */
export const PREVIEW_RESIZE = {
  width: 1024,
  height: 1024,
  fit: 'inside',
  withoutEnlargement: true,
} as const

/**
 * 把一张图缩成预览。看一眼判断「是不是那张图」用它就够，而原件一次就是几 MB 的 data URL。
 *
 * 缩不动就原样返回：预览只是省钱，为省钱让模型取不到图是本末倒置。
 */
export async function toPreviewDataUrl(dataUrl: string): Promise<string> {
  const parsed = parseDataUrl(dataUrl)
  if (!parsed) return dataUrl
  try {
    const preview = await sharp(parsed.bytes).rotate().resize(PREVIEW_RESIZE).webp({ quality: 75 })
    return `data:image/webp;base64,${(await preview.toBuffer()).toString('base64')}`
  } catch {
    return dataUrl
  }
}

import type { ImageContent } from '@earendil-works/pi-ai'
import sharp from 'sharp'

interface Reference {
  readonly dataUrl: string
  readonly maskDataUrl?: string
}

/** 与画布预览相同：mask 的透明像素是用户圈选区；只给 LLM 看，绝不替换生图原图。 */
export async function selectionPreview(reference: Reference): Promise<ImageContent> {
  const raw = Buffer.from(reference.dataUrl.slice(reference.dataUrl.indexOf(',') + 1), 'base64')
  if (!reference.maskDataUrl) {
    return {
      type: 'image',
      mimeType: reference.dataUrl.slice(5, reference.dataUrl.indexOf(';')),
      data: raw.toString('base64'),
    }
  }
  const mask = Buffer.from(reference.maskDataUrl.split(',')[1]!, 'base64')
  const { data, info } = await sharp(mask).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const target = await sharp(raw).metadata()
  if (target.width !== info.width || target.height !== info.height) {
    throw new Error('Reference mask dimensions do not match image')
  }
  const overlay = Buffer.alloc(info.width * info.height * 4)
  for (let pixel = 0; pixel < info.width * info.height; pixel += 1) {
    overlay[pixel * 4] = 59
    overlay[pixel * 4 + 1] = 130
    overlay[pixel * 4 + 2] = 246
    overlay[pixel * 4 + 3] = Math.round(
      (255 - data[pixel * info.channels + info.channels - 1]!) * 0.58,
    )
  }
  const preview = await sharp(raw)
    .composite([{ input: overlay, raw: { width: info.width, height: info.height, channels: 4 } }])
    .png()
    .toBuffer()
  return { type: 'image', mimeType: 'image/png', data: preview.toString('base64') }
}

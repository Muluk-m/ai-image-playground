import { createHash } from 'node:crypto'
import type { ImageContent } from '@earendil-works/pi-ai'
import sharp from 'sharp'
import { toModelImageDataUrl } from './modelImage'
import { selectionSettings as settings } from './selection-settings'

interface Reference {
  readonly dataUrl: string
  readonly maskDataUrl?: string
}

export class InvalidSelectionError extends Error {}

export interface ImageSelection {
  readonly id: string
  readonly crop: string
  readonly preview: ImageContent
  readonly bounds: { left: number; top: number; width: number; height: number }
}

function asImage(dataUrl: string): ImageContent {
  return {
    type: 'image',
    mimeType: dataUrl.slice(5, dataUrl.indexOf(';')),
    data: dataUrl.slice(dataUrl.indexOf(',') + 1),
  }
}

/** ID 同时绑定图片与 mask 字节，旧选区不能静默套用到同尺寸的新版本。 */
export async function imageSelection(
  reference: Reference,
  render = true,
): Promise<ImageSelection | undefined> {
  if (!reference.maskDataUrl) return undefined
  try {
    await sharp(Buffer.from(reference.dataUrl.split(',')[1]!, 'base64'), {
      limitInputPixels: settings.maxPixels,
    }).metadata()
    const normalized = await toModelImageDataUrl(reference.dataUrl)
    const raw = Buffer.from(normalized.split(',')[1]!, 'base64')
    const mask = Buffer.from(reference.maskDataUrl.split(',')[1]!, 'base64')
    const [target, metadata] = await Promise.all([
      sharp(raw, { limitInputPixels: settings.maxPixels }).metadata(),
      sharp(mask, { limitInputPixels: settings.maxPixels }).metadata(),
    ])
    if (!metadata.hasAlpha) throw new Error('遮罩缺少透明选区，请重新圈选')
    if ((target.orientation ?? 1) !== 1 || (metadata.orientation ?? 1) !== 1) {
      throw new Error('图片方向与选区无法对应，请重新添加图片并圈选')
    }
    const { data, info } = await sharp(mask)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (target.width !== info.width || target.height !== info.height) {
      throw new Error('图片与选区尺寸不一致，请重新圈选')
    }
    let left = info.width
    let top = info.height
    let right = -1
    let bottom = -1
    const overlay = Buffer.alloc(render ? info.width * info.height * 4 : 0)
    const selectionAlpha = Buffer.alloc(info.width * info.height)
    for (let pixel = 0; pixel < selectionAlpha.length; pixel++) {
      const alpha = 255 - data[pixel * info.channels + info.channels - 1]!
      selectionAlpha[pixel] = alpha
      if (alpha > 0) {
        const x = pixel % info.width
        const y = Math.floor(pixel / info.width)
        left = Math.min(left, x)
        top = Math.min(top, y)
        right = Math.max(right, x)
        bottom = Math.max(bottom, y)
      }
      if (render) overlay.set([59, 130, 246, Math.round(alpha * 0.58)], pixel * 4)
    }
    if (right < 0) throw new Error('没有选中任何区域，请重新圈选')
    const bounds = { left, top, width: right - left + 1, height: bottom - top + 1 }
    const id = `selection_${createHash('sha256').update(raw).update(mask).digest('hex')}`
    if (!render)
      return { id, bounds, crop: '', preview: { type: 'image', mimeType: 'image/png', data: '' } }
    const preview = await sharp(raw)
      .composite([{ input: overlay, raw: { width: info.width, height: info.height, channels: 4 } }])
      .png()
      .toBuffer()
    // 参考裁片只携带原色选区；不把定位用的蓝色或总包围框内的未选对象送入生图参考。
    const selectedPixels = await sharp(raw).ensureAlpha().raw().toBuffer()
    for (let pixel = 0; pixel < selectionAlpha.length; pixel++) {
      selectedPixels[pixel * 4 + 3] = Math.round(
        (selectedPixels[pixel * 4 + 3]! * selectionAlpha[pixel]!) / 255,
      )
    }
    const crop = await sharp(selectedPixels, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .extract(bounds)
      .png()
      .toBuffer()
    return {
      id,
      bounds,
      crop: `data:image/png;base64,${crop.toString('base64')}`,
      preview: { type: 'image', mimeType: 'image/png', data: preview.toString('base64') },
    }
  } catch (error) {
    throw new InvalidSelectionError(
      error instanceof Error ? error.message : '选区无法读取，请重新圈选',
    )
  }
}

/**
 * 一个引用的视觉证据由哪几块组成：原图始终保留，有选区时再加蓝色定位图与原色选区裁片。
 * 实发路径拿真字节代入，预扣估算拿占位块代入——张数这条规则只写在这里，两边不会各数各的。
 */
export function evidenceBlocks<T>(
  original: T,
  selection?: { readonly preview: T; readonly crop: T },
): T[] {
  return selection ? [original, selection.preview, selection.crop] : [original]
}

/** 原图始终保留；定位图与原色选区裁片是补充证据。 */
export async function referenceEvidence(references: readonly (Reference & { imageId: string })[]) {
  const content: ImageContent[] = []
  const descriptions: string[] = []
  for (const reference of references) {
    const original = await toModelImageDataUrl(reference.dataUrl)
    const selection = await imageSelection(reference)
    const first = content.length + 1
    content.push(
      ...evidenceBlocks(
        asImage(original),
        selection && { preview: selection.preview, crop: asImage(selection.crop) },
      ),
    )
    if (!selection) {
      descriptions.push(`视觉输入 ${first}：图片 ${reference.imageId} 原图`)
      continue
    }
    descriptions.push(
      `视觉输入 ${first}：图片 ${reference.imageId} 原图；${first + 1}：蓝色定位图；${first + 2}：原色选区裁片。选区 ID ${selection.id}，位置 ${JSON.stringify(selection.bounds)}。蓝色和裁片透明处均为定位信息，不是产品外观。`,
    )
  }
  return {
    content,
    manifest: `\n\n视觉证据（这些序号不是用户的 image 编号）：\n${descriptions.join('\n')}`,
  }
}

export async function selectionPreview(reference: Reference): Promise<ImageContent> {
  return (
    (await imageSelection(reference))?.preview ??
    asImage(await toModelImageDataUrl(reference.dataUrl))
  )
}

/** 入口仅校验，不制作大图；逐张处理避免同轮多张图同时占用 raw 缓冲。 */
export async function validateSelections(references: readonly Reference[]): Promise<void> {
  for (const reference of references) await imageSelection(reference, false)
}

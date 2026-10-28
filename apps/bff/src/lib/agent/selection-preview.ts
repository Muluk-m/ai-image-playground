import { createHash } from 'node:crypto'
import type { ImageContent } from '@earendil-works/pi-ai'
import type { AgentTurnReference } from '@image-playground/shared'
import sharp from 'sharp'
import {
  editInputSize,
  previewResize,
  toModelImageDataUrl,
  toSourceImageDataUrl,
} from './modelImage'
import { selectionSettings as settings } from './selection-settings'
import { assertVisualBytes, visualPixelLimit, withVisualPreparation } from './visual-resources'

interface Reference {
  readonly dataUrl: string
  readonly maskDataUrl?: string
  readonly editAction?: import('@image-playground/shared').AgentImageEditAction
  readonly regions?: readonly import('@image-playground/shared').AgentMarkedRegion[]
}

export class InvalidSelectionError extends Error {}

export function editActionIntent(action: NonNullable<Reference['editAction']>) {
  return {
    inpaint: '局部重绘：结合原图和正文要求编辑所有指定区域',
    erase: '擦除：移除指定内容并结合邻近画面补全；正文可补充保留要求',
    crop: '裁剪后生成：输入已经按用户构图裁切，以此构图完成正文要求，不重复裁切',
    outpaint: '扩图：输入已扩展透明边缘，结合原图场景与正文补全透明区域',
  }[action]
}

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

/**
 * 箭头标注只画在定位图上：从尾端指向区域中心，末端一个实心箭头。文字不画——服务器上
 * 未必有中文字体，标注原文已经随编号写进清单。
 */
function arrowMarkup(
  region: { x: number; y: number; width: number; height: number; arrow?: { x: number; y: number } },
  width: number,
  height: number,
  radius: number,
): string {
  if (!region.arrow) return ''
  const fromX = region.arrow.x * width
  const fromY = region.arrow.y * height
  const toX = (region.x + region.width / 2) * width
  const toY = (region.y + region.height / 2) * height
  const length = Math.hypot(toX - fromX, toY - fromY)
  if (length < 1) return ''
  const unitX = (toX - fromX) / length
  const unitY = (toY - fromY) / length
  const head = Math.min(length, radius * 1.6)
  const baseX = toX - unitX * head
  const baseY = toY - unitY * head
  const side = head * 0.55
  const points = [
    `${toX},${toY}`,
    `${baseX - unitY * side},${baseY + unitX * side}`,
    `${baseX + unitY * side},${baseY - unitX * side}`,
  ].join(' ')
  return `<line x1="${fromX}" y1="${fromY}" x2="${baseX}" y2="${baseY}" stroke="#159cf6" stroke-width="${radius / 3}" stroke-linecap="round"/><polygon points="${points}" fill="#159cf6"/>`
}

/**
 * ID 同时绑定图片与 mask 字节，旧选区不能静默套用到同尺寸的新版本。
 *
 * 选区的 ID 与位置按原件像素算；给对话模型看的定位图先缩到预览规格再画，原色裁片超出准备
 * 预算时等比缩小。原件本身不按 `agent:visual-max-pixels` 拒：8000×4500 的图也能圈、能改。
 * 只按单通道遮罩逐像素扫，避免在超大原图上同时摊开几份 RGBA 缓冲。
 */
async function prepareSelection(
  reference: Reference,
  render = true,
): Promise<ImageSelection | undefined> {
  if (!reference.maskDataUrl) return undefined
  try {
    const originalMetadata = await sharp(Buffer.from(reference.dataUrl.split(',')[1]!, 'base64'), {
      limitInputPixels: settings.maxPixels,
    }).metadata()
    if ((originalMetadata.orientation ?? 1) !== 1)
      throw new Error('图片方向与选区无法对应，请重新添加图片并圈选')
    const normalized = await toSourceImageDataUrl(reference.dataUrl)
    const raw = Buffer.from(normalized.split(',')[1]!, 'base64')
    assertVisualBytes(Buffer.byteLength(reference.maskDataUrl, 'utf8'))
    const mask = Buffer.from(reference.maskDataUrl.split(',')[1]!, 'base64')
    const [target, metadata] = await Promise.all([
      sharp(raw, { limitInputPixels: settings.maxPixels }).metadata(),
      sharp(mask, { limitInputPixels: settings.maxPixels }).metadata(),
    ])
    if (!metadata.hasAlpha) throw new Error('遮罩缺少透明选区，请重新圈选')
    if ((target.orientation ?? 1) !== 1 || (metadata.orientation ?? 1) !== 1) {
      throw new Error('图片方向与选区无法对应，请重新添加图片并圈选')
    }
    const width = target.width ?? 0
    const height = target.height ?? 0
    if (!width || !height || width !== metadata.width || height !== metadata.height) {
      throw new Error('图片与选区尺寸不一致，请重新圈选')
    }
    const { data: maskAlpha } = await sharp(mask, { limitInputPixels: settings.maxPixels })
      .ensureAlpha()
      .extractChannel(3)
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (maskAlpha.length !== width * height) throw new Error('图片与选区尺寸不一致，请重新圈选')
    let left = width
    let top = height
    let right = -1
    let bottom = -1
    // 遮罩透明处是选区：反过来存成「选中程度」。
    const selectionAlpha = Buffer.alloc(width * height)
    for (let pixel = 0; pixel < selectionAlpha.length; pixel++) {
      const alpha = 255 - maskAlpha[pixel]!
      selectionAlpha[pixel] = alpha
      if (alpha > 0) {
        const x = pixel % width
        const y = Math.floor(pixel / width)
        if (x < left) left = x
        if (y < top) top = y
        if (x > right) right = x
        if (y > bottom) bottom = y
      }
    }
    if (right < 0) throw new Error('没有选中任何区域，请重新圈选')
    const bounds = { left, top, width: right - left + 1, height: bottom - top + 1 }
    const id = `selection_${createHash('sha256').update(raw).update(mask).digest('hex')}`
    if (!render)
      return { id, bounds, crop: '', preview: { type: 'image', mimeType: 'image/png', data: '' } }

    // 定位图只给对话模型看「圈在哪」：先缩到预览规格再叠蓝色与编号。原尺寸 PNG 在 4K 原图上
    // 就有十几 MB，连同原件和裁片一起会超出整轮的图片字节预算，确认卡就提交不了。
    const base = await sharp(raw, { limitInputPixels: settings.maxPixels })
      .resize(previewResize(width, height))
      .raw()
      .toBuffer({ resolveWithObject: true })
    const small = base.info
    const smallAlpha = await sharp(selectionAlpha, { raw: { width, height, channels: 1 } })
      .resize(small.width, small.height, { fit: 'fill' })
      // 单通道 raw 缩放后会被当成 sRGB 扩成三通道，只取回第一个。
      .extractChannel(0)
      .raw()
      .toBuffer()
    const overlay = Buffer.alloc(small.width * small.height * 4)
    for (let pixel = 0; pixel < smallAlpha.length; pixel++)
      overlay.set([59, 130, 246, Math.round(smallAlpha[pixel]! * 0.58)], pixel * 4)
    // 编号圈的大小按原图量、再随定位图等比缩：与先在原图上画再缩的观感一致。
    const scale = small.width / width
    const radius = Math.max(8, Math.min(width, height) * 0.014) * scale
    const regionLabels = (reference.regions ?? [])
      .map((region, index) => {
        const x = region.x * small.width,
          y = region.y * small.height
        return `${arrowMarkup(region, small.width, small.height, radius)}<rect x="${x}" y="${y}" width="${region.width * small.width}" height="${region.height * small.height}" fill="none" stroke="#159cf6" stroke-width="${radius / 5}"/><circle cx="${x + radius}" cy="${y + radius}" r="${radius}" fill="#159cf6" stroke="white" stroke-width="${radius / 6}"/><text x="${x + radius}" y="${y + radius * 1.35}" text-anchor="middle" fill="white" font-size="${radius * 1.3}" font-family="sans-serif">${region.number ?? index + 1}</text>`
      })
      .join('')
    const preview = await sharp(base.data, { raw: small })
      .composite([
        { input: overlay, raw: { width: small.width, height: small.height, channels: 4 } },
        ...(regionLabels
          ? [
              {
                input: Buffer.from(
                  `<svg width="${small.width}" height="${small.height}" xmlns="http://www.w3.org/2000/svg">${regionLabels}</svg>`,
                ),
              },
            ]
          : []),
      ])
      .png()
      .toBuffer()
    // 参考裁片只携带原色选区；不把定位用的蓝色或总包围框内的未选对象送入生图参考。
    // 只解码包围框那一块；超出准备预算的才等比缩小（与改图输入同一条规则）。
    const croppedPixels = await sharp(raw, { limitInputPixels: settings.maxPixels })
      .extract(bounds)
      .ensureAlpha()
      .raw()
      .toBuffer()
    for (let row = 0; row < bounds.height; row++)
      for (let column = 0; column < bounds.width; column++) {
        const at = (row * bounds.width + column) * 4 + 3
        croppedPixels[at] = Math.round(
          (croppedPixels[at]! *
            selectionAlpha[(bounds.top + row) * width + bounds.left + column]!) /
            255,
        )
      }
    let cropImage = sharp(croppedPixels, {
      raw: { width: bounds.width, height: bounds.height, channels: 4 },
    })
    if (bounds.width * bounds.height > visualPixelLimit()) {
      const fitted = editInputSize(bounds.width, bounds.height)
      cropImage = cropImage.resize(fitted.width, fitted.height, { fit: 'fill' })
    }
    const crop = await cropImage.png().toBuffer()
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

/** 清单里一个引用要交代的全部：它是哪张图，有没有选区、选区是哪一个、圈在哪。 */
export interface EvidenceListing {
  readonly imageId: string
  readonly representation?: 'original' | 'preview' | 'region'
  readonly editAction?: Reference['editAction']
  readonly regions?: Reference['regions']
  readonly selection?: { readonly id: string; readonly bounds: ImageSelection['bounds'] }
  /** 这一块送给模型的像素尺寸：圈范围、给坐标时按它归一化。 */
  readonly size?: { readonly width: number; readonly height: number }
}

const sizeNote = (size: EvidenceListing['size']) =>
  size ? `（${size.width}×${size.height} 像素）` : ''

/**
 * 清单文本怎么写只写在这里：实发路径代入真的选区 ID 与位置，预扣估算代入等长占位。
 * 序号跟着 `evidenceBlocks` 数出来的块数走，两边不会各数各的；改措辞两边一起跟着变。
 *
 * 没有引用就没有清单：只剩一个清单头接在 prompt 末尾，既白费 token，也给模型留了一句没有下文的话。
 */
export function evidenceManifest(references: readonly EvidenceListing[]): string {
  if (references.length === 0) return ''
  const descriptions: string[] = []
  let blocks = 0
  for (const { imageId, selection, regions, editAction, representation, size } of references) {
    const first = blocks + 1
    blocks += evidenceBlocks(1, selection && { preview: 1, crop: 1 }).length
    if (editAction)
      descriptions.push(
        `图片 ${imageId} 的编辑动作：${editActionIntent(editAction)}（用户在编辑器选择）；正文是该动作的具体要求。`,
      )
    descriptions.push(
      selection
        ? `视觉输入 ${first}：图片 ${imageId} 原图${sizeNote(size)}；${first + 1}：蓝色定位图；${first + 2}：原色选区裁片。选区 ID ${selection.id}，位置 ${JSON.stringify(selection.bounds)}。蓝色和裁片透明处均为定位信息，不是产品外观。${regions?.length ? `区域编号按以下归一化坐标对应：${regions.map((region, index) => `区域 ${region.number ?? index + 1} ${JSON.stringify(region)}`).join('；')}。编号仅用于定位，以遮罩覆盖像素为准。` : ''}`
        : `视觉输入 ${first}：图片 ${imageId} ${{ original: '原图', preview: '缩略图', region: '局部' }[representation ?? 'original']}${sizeNote(size)}`,
    )
  }
  return `\n\n视觉证据（这些序号不是用户的 image 编号）：\n${descriptions.join('\n')}`
}

/** 原图始终保留；定位图与原色选区裁片是补充证据。 */
export async function referenceEvidence(references: readonly (Reference & { imageId: string })[]) {
  const content: ImageContent[] = []
  const listed: EvidenceListing[] = []
  for (const reference of references) {
    const original = await toModelImageDataUrl(reference.dataUrl)
    const selection = await imageSelection(reference)
    content.push(
      ...evidenceBlocks(
        asImage(original),
        selection && { preview: selection.preview, crop: asImage(selection.crop) },
      ),
    )
    listed.push({
      imageId: reference.imageId,
      regions: reference.regions,
      editAction: reference.editAction,
      ...(selection ? { selection: { id: selection.id, bounds: selection.bounds } } : {}),
    })
  }
  return { content, manifest: evidenceManifest(listed), listed }
}

export async function selectionPreview(reference: Reference): Promise<ImageContent> {
  return (
    (await imageSelection(reference))?.preview ??
    asImage(await toModelImageDataUrl(reference.dataUrl))
  )
}

/**
 * 入口仅校验，不制作大图；逐张处理避免同轮多张图同时占用 raw 缓冲。
 * 按 id 附来的那一路没有字节也没有遮罩，本来就没有选区可校验。
 */
export async function validateSelections(references: readonly AgentTurnReference[]): Promise<void> {
  for (const reference of references)
    if ('dataUrl' in reference && reference.maskDataUrl)
      await imageSelection(
        { dataUrl: reference.dataUrl, maskDataUrl: reference.maskDataUrl },
        false,
      )
}

export const imageSelection = (
  reference: Reference,
  render = true,
): Promise<ImageSelection | undefined> =>
  withVisualPreparation(() => prepareSelection(reference, render))

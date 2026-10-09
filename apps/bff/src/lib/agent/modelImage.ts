import sharp from 'sharp'
import { AgentToolError } from './tools/errors'
import {
  assertVisualBytes,
  visualMetadata,
  visualPixelLimit,
  withVisualPreparation,
} from './visual-resources'

function conversionFailure(): never {
  throw new AgentToolError(
    'invalid_params',
    '图片无法安全转换或裁取，未发送原件。请重新添加有效图片，或明确选择需要查看的区域。',
  )
}

/** 对话模型与生图上游只认这几种位图；其余（SVG、AVIF、HEIC、TIFF、BMP…）先转成 PNG。 */
export const MODEL_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

function parseDataUrl(value: string): { mime: string; bytes: Buffer } | null {
  assertVisualBytes(Buffer.byteLength(value, 'utf8'))
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(value)
  return match ? { mime: match[1]!.toLowerCase(), bytes: Buffer.from(match[2]!, 'base64') } : null
}

/**
 * 把一张参考图变成上游接受的格式。画布可存 SVG，用户也能拖进 AVIF / HEIC；
 * 转换失败时明确拒绝，不能把本应转换的无界原件送给模型。
 */
async function normalizeImage(dataUrl: string): Promise<string> {
  const parsed = parseDataUrl(dataUrl)
  if (!parsed) return conversionFailure()
  await visualMetadata(parsed.bytes)
  if (MODEL_IMAGE_MIMES.has(parsed.mime)) return dataUrl
  try {
    const png = await sharp(parsed.bytes, { limitInputPixels: visualPixelLimit() }).png().toBuffer()
    return `data:image/png;base64,${png.toString('base64')}`
  } catch {
    return conversionFailure()
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
 * 转换失败必须明确报告；不能把预览请求静默升级为无界原件。
 */
async function previewImage(dataUrl: string): Promise<string> {
  const parsed = parseDataUrl(dataUrl)
  if (!parsed) return conversionFailure()
  await visualMetadata(parsed.bytes)
  try {
    const preview = await sharp(parsed.bytes, { limitInputPixels: visualPixelLimit() })
      .rotate()
      .resize(PREVIEW_RESIZE)
      .webp({ quality: 75 })
    return `data:image/webp;base64,${(await preview.toBuffer()).toString('base64')}`
  } catch {
    return conversionFailure()
  }
}

/** 归一化的取景框：按比例给，模型不必知道这张图有多少像素。 */
export interface ImageRegion {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * 从原件里裁一块出来看。
 *
 * 裁完仍按预览规格收一次口：**成本因此恒定，细节靠把框缩小换来**。不收口的话
 * `region` 等于又开了一个取整张原件的入口——框给成 0~1 就是整张图。
 *
 * 裁取失败必须报告，不能静默改为查看整张原件。
 */
async function regionImage(dataUrl: string, region: ImageRegion): Promise<string> {
  const parsed = parseDataUrl(dataUrl)
  if (!parsed) return conversionFailure()
  await visualMetadata(parsed.bytes)
  try {
    const image = sharp(parsed.bytes, { limitInputPixels: visualPixelLimit() }).rotate()
    const { width, height } = await image.metadata()
    if (!width || !height) return conversionFailure()
    const left = Math.min(Math.max(Math.round(region.x * width), 0), width - 1)
    const top = Math.min(Math.max(Math.round(region.y * height), 0), height - 1)
    const cropped = await image
      .extract({
        left,
        top,
        width: Math.min(Math.max(Math.round(region.width * width), 1), width - left),
        height: Math.min(Math.max(Math.round(region.height * height), 1), height - top),
      })
      .resize(PREVIEW_RESIZE)
      .webp({ quality: 80 })
      .toBuffer()
    return `data:image/webp;base64,${cropped.toString('base64')}`
  } catch {
    return conversionFailure()
  }
}

export const toModelImageDataUrl = (dataUrl: string): Promise<string> =>
  withVisualPreparation(() => normalizeImage(dataUrl))
export const toPreviewDataUrl = (dataUrl: string): Promise<string> =>
  withVisualPreparation(() => previewImage(dataUrl))
export const toRegionDataUrl = (dataUrl: string, region: ImageRegion): Promise<string> =>
  withVisualPreparation(() => regionImage(dataUrl, region))

import { MAX_IMAGE_UPLOAD_BYTES } from '@image-playground/shared'
import sharp, { type Metadata } from 'sharp'
import { config } from '../../config'
import { assertMediaImageProcessingBudget, MEDIA_UPLOAD_MAX_PIXELS } from '../media-image-limits'
import { AgentToolError } from './tools/errors'
import {
  assertVisualBytes,
  previewSourceByteLimit,
  visualByteLimit,
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

function parseDataUrl(
  value: string,
  sourceOnly: boolean | 'checked' = false,
): { mime: string; bytes: Buffer } | null {
  // 只用来现缩的源图不进请求，按像素预算折出的上限卡；其余直接进请求，按请求预算卡。
  // 'checked'：调用方已按自己的源图上限卡过。
  const bytes = Buffer.byteLength(value, 'utf8')
  if (!sourceOnly) assertVisualBytes(bytes)
  else if (sourceOnly === true && bytes > previewSourceByteLimit())
    throw new AgentToolError(
      'quota_exceeded',
      `图片需要 ${bytes} 字节，超过预览源图上限 ${previewSourceByteLimit()}；本次图片未送入模型。请重新添加符合预算的图片。`,
    )
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
  const parsed = parseDataUrl(dataUrl, true)
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

/**
 * 改图输入的最长边（BUG-35，Nain 2026-10-28 定）：超大图先等比缩到这以内再改，不再整轮拒绝。
 * 上游出图本来只有 1–4 MP，缩到 4000 不影响结果。
 */
export const EDIT_INPUT_MAX_EDGE = 4000

/** 改图源图能读多大：与用户能上传的一致（`mediaLimits`），不按请求预算卡——缩完才进请求。 */
export function editSourceByteLimit(): number {
  return Math.max(
    visualByteLimit(),
    Math.ceil(
      (Math.min(config.operator.quotas['sync:asset-image-bytes'], MAX_IMAGE_UPLOAD_BYTES) * 4) / 3,
    ) + 64,
  )
}

/** 缩到最长边 ≤ {@link EDIT_INPUT_MAX_EDGE} 且像素不超准备预算；极端长宽比按两者中更紧的那条收。 */
export function editInputSize(
  width: number,
  height: number,
  pixelLimit = visualPixelLimit(),
): { width: number; height: number } {
  const scale = Math.min(
    1,
    EDIT_INPUT_MAX_EDGE / Math.max(width, height),
    Math.sqrt(pixelLimit / (width * height)),
  )
  if (scale >= 1) return { width, height }
  // 向下取整，保证两条上限都不被四舍五入顶破；短边至少 1px。
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  }
}

/**
 * 改图输入：最长边超过 4000、像素超准备预算或字节超请求预算的图，按 EXIF 方向摆正后等比缩小，
 * 不透明的转 JPEG、带透明的转 PNG（放不下再转 WebP）。其余照常走格式归一，原样送出。
 *
 * 源图解码上限与上传校验同源（{@link MEDIA_UPLOAD_MAX_PIXELS} + 处理预算），能挂上的图都能改。
 */
async function editInputImage(dataUrl: string): Promise<string> {
  const bytes = Buffer.byteLength(dataUrl, 'utf8')
  if (bytes > editSourceByteLimit())
    throw new AgentToolError(
      'quota_exceeded',
      `图片需要 ${bytes} 字节，超过改图源图上限 ${editSourceByteLimit()}；本次图片未送入模型。请重新添加更小的图片。`,
    )
  const parsed = parseDataUrl(dataUrl, 'checked')
  if (!parsed) return conversionFailure()
  let metadata: Metadata
  try {
    metadata = await sharp(parsed.bytes, { limitInputPixels: MEDIA_UPLOAD_MAX_PIXELS }).metadata()
    if (!metadata.width || !metadata.height) return conversionFailure()
    assertMediaImageProcessingBudget({
      ...metadata,
      width: metadata.width,
      height: metadata.height,
    })
  } catch (error) {
    if (error instanceof AgentToolError) throw error
    return conversionFailure()
  }
  const pixelLimit = visualPixelLimit()
  const pages = metadata.pages ?? 1
  // 方向 5–8 存的是转置后的宽高，按显示方向算长边。
  const turned = (metadata.orientation ?? 1) >= 5
  const width = turned ? metadata.height : metadata.width
  const height = turned ? metadata.width : metadata.height
  const oversized =
    Math.max(width, height) > EDIT_INPUT_MAX_EDGE ||
    width * height * pages > pixelLimit ||
    bytes > visualByteLimit()
  if (!oversized) return normalizeImage(dataUrl)
  const target = editInputSize(width, height, pixelLimit)
  try {
    const resized = sharp(parsed.bytes, { limitInputPixels: MEDIA_UPLOAD_MAX_PIXELS })
      .timeout({ seconds: 30 })
      .rotate()
      .resize({ width: target.width, height: target.height, fit: 'fill' })
    let output: { buffer: Buffer; mime: string }
    if (metadata.hasAlpha) {
      output = { buffer: await resized.clone().png().toBuffer(), mime: 'image/png' }
      if (Math.ceil((output.buffer.length * 4) / 3) + 32 > visualByteLimit())
        output = { buffer: await resized.webp({ quality: 90 }).toBuffer(), mime: 'image/webp' }
    } else {
      output = {
        buffer: await resized.flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer(),
        mime: 'image/jpeg',
      }
    }
    const fitted = `data:${output.mime};base64,${output.buffer.toString('base64')}`
    assertVisualBytes(Buffer.byteLength(fitted, 'utf8'))
    return fitted
  } catch (error) {
    if (error instanceof AgentToolError) throw error
    return conversionFailure()
  }
}

export const toModelImageDataUrl = (dataUrl: string): Promise<string> =>
  withVisualPreparation(() => normalizeImage(dataUrl))
/** 送进改图的输入（无遮罩）：超大图等比缩小后再送，见 {@link editInputImage}。 */
export const toEditInputDataUrl = (dataUrl: string): Promise<string> =>
  withVisualPreparation(() => editInputImage(dataUrl))
export const toPreviewDataUrl = (dataUrl: string): Promise<string> =>
  withVisualPreparation(() => previewImage(dataUrl))
export const toRegionDataUrl = (dataUrl: string, region: ImageRegion): Promise<string> =>
  withVisualPreparation(() => regionImage(dataUrl, region))

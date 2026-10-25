import sharp, { type ExtendOptions } from 'sharp'
import { maskedEditSettings } from './masked-edit-settings'
import { selectionSettings } from './selection-settings'

/** 原图尺寸对这个模型能不能做原尺寸局部编辑；能做时给出补边后的尺寸，不能时给出那句原因。 */
export function maskedEditSize(
  model: string,
  width: number,
  height: number,
): { paddedWidth: number; paddedHeight: number } | { problem: string } {
  const limits = maskedEditSettings.output
  const customSize = /^gpt-image-2(?:[.-]|$)/.test(model)
  if (
    !customSize &&
    (!/^gpt-image-1(?:[.-]|$)/.test(model) ||
      !['1024x1024', '1536x1024', '1024x1536'].includes(`${width}x${height}`))
  )
    return { problem: '当前模型不支持这张图的原尺寸局部编辑，请选择 GPT Image 2 系列' }
  const paddedWidth = customSize
    ? Math.ceil(width / limits.dimensionMultiple) * limits.dimensionMultiple
    : width
  const paddedHeight = customSize
    ? Math.ceil(height / limits.dimensionMultiple) * limits.dimensionMultiple
    : height
  if (
    Math.max(paddedWidth, paddedHeight) > limits.maxEdge ||
    Math.max(paddedWidth / paddedHeight, paddedHeight / paddedWidth) > limits.maxAspectRatio ||
    paddedWidth * paddedHeight < limits.minPixels ||
    paddedWidth * paddedHeight > limits.maxPixels
  )
    return { problem: '原图尺寸超出模型支持的局部编辑范围，请先调整图片尺寸再选择区域' }
  return { paddedWidth, paddedHeight }
}

/**
 * 上游（经网关的 gpt-image-2.5-flare）不管请求的 size 与 quality，一律按输入的长宽比出约
 * 1536×1024 像素：3840×2160 的原图回来只有 1672×941，选区里要放大 2.3 倍。测试环境实测
 * 3840x2160、2560x1440、auto、quality=high 都是 1672×941；截一块约这么大的区域送上去，
 * 回来就是原样大小（1488×1056 → 1489×1056）。
 */
export const UPSTREAM_OUTPUT_PIXELS = 1536 * 1024
/** 截图比整图至少要把选区里的放大倍数降到这么多分之一，否则不值得丢掉整图的上下文。 */
export const MASKED_CROP_MIN_GAIN = 1.25
/** 选区四周至少留这么多像素的上下文；默认取选区长边的 10%，放不下时往这个数收。 */
export const MASKED_CROP_MIN_MARGIN = 32
const MASKED_CROP_MARGIN_FRACTION = 0.1

export interface MaskedCrop {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** 补到尺寸倍数（只补右、下）后的宽高；整图与截图共用这一个规则。 */
export function paddedEditSize(width: number, height: number) {
  const multiple = maskedEditSettings.output.dimensionMultiple
  return {
    width: Math.ceil(width / multiple) * multiple,
    height: Math.ceil(height / multiple) * multiple,
  }
}

function sizeProblem(width: number, height: number) {
  const limits = maskedEditSettings.output
  return (
    Math.max(width, height) > limits.maxEdge ||
    Math.max(width / height, height / width) > limits.maxAspectRatio ||
    width * height < limits.minPixels ||
    width * height > limits.maxPixels
  )
}

/**
 * 选区只占大图一小块时，围着选区截一块约上游原生出图大小的区域单独送上去，让选区里的像素
 * 不再被放大；回来的图贴回截取位置，再照常只在选区内合成。`bounds` 是选区外接框
 * （左上含、右下不含）。不划算（整图本来就不大，或选区本身太大）时返回 null，走整图。
 */
export function maskedEditCrop(
  width: number,
  height: number,
  bounds: { left: number; top: number; right: number; bottom: number },
  budget = UPSTREAM_OUTPUT_PIXELS,
): MaskedCrop | null {
  const full = width * height
  const gain = MASKED_CROP_MIN_GAIN * MASKED_CROP_MIN_GAIN
  if (full <= budget * gain) return null
  const boxWidth = bounds.right - bounds.left
  const boxHeight = bounds.bottom - bounds.top
  if (boxWidth <= 0 || boxHeight <= 0) return null
  // 外扩 m 时面积 (w+2m)(h+2m) 不超过预算的最大 m；夹在 [最小边距, 首选边距] 之间。
  const preferred = Math.max(
    MASKED_CROP_MIN_MARGIN,
    Math.round(MASKED_CROP_MARGIN_FRACTION * Math.max(boxWidth, boxHeight)),
  )
  const sum = boxWidth + boxHeight
  const fitting = (-sum + Math.sqrt(sum * sum - 4 * (boxWidth * boxHeight - budget))) / 4
  const margin = Math.min(
    preferred,
    Math.max(MASKED_CROP_MIN_MARGIN, Number.isFinite(fitting) ? Math.floor(fitting) : 0),
  )
  let cropWidth = Math.min(width, boxWidth + 2 * margin)
  let cropHeight = Math.min(height, boxHeight + 2 * margin)
  // 比预算小就按原比例往外长到预算（多给上下文，回来的图只会缩小不会放大）。
  if (cropWidth * cropHeight < budget) {
    const grow = Math.sqrt(budget / (cropWidth * cropHeight))
    cropWidth = Math.min(width, Math.floor(cropWidth * grow))
    cropHeight = Math.min(height, Math.floor(cropHeight * grow))
    if (cropWidth === width) cropHeight = Math.min(height, Math.floor(budget / cropWidth))
    else if (cropHeight === height) cropWidth = Math.min(width, Math.floor(budget / cropHeight))
  }
  // 长宽比与最小像素按上游限制补齐（补的是上下文，选区始终完整在内）。
  const ratio = maskedEditSettings.output.maxAspectRatio
  if (cropWidth / cropHeight > ratio) cropHeight = Math.min(height, Math.ceil(cropWidth / ratio))
  if (cropHeight / cropWidth > ratio) cropWidth = Math.min(width, Math.ceil(cropHeight / ratio))
  const minPixels = maskedEditSettings.output.minPixels
  if (cropWidth * cropHeight < minPixels) {
    const grow = Math.sqrt(minPixels / (cropWidth * cropHeight))
    cropWidth = Math.min(width, Math.ceil(cropWidth * grow))
    cropHeight = Math.min(height, Math.ceil(cropHeight * grow))
  }
  const padded = paddedEditSize(cropWidth, cropHeight)
  if (sizeProblem(padded.width, padded.height)) return null
  if (cropWidth * cropHeight * gain > full) return null
  const centerX = (bounds.left + bounds.right) / 2
  const centerY = (bounds.top + bounds.bottom) / 2
  const left = Math.max(0, Math.min(width - cropWidth, Math.round(centerX - cropWidth / 2)))
  const top = Math.max(0, Math.min(height - cropHeight, Math.round(centerY - cropHeight / 2)))
  // 夹回图内后选区仍须完整在截图里（选区比截图还宽高时就不截）。
  if (
    bounds.left < left ||
    bounds.top < top ||
    bounds.right > left + cropWidth ||
    bounds.bottom > top + cropHeight
  )
    return null
  return { left, top, width: cropWidth, height: cropHeight }
}

/** 选区（alpha < 255 的像素）外接框；没有选区时返回 null。 */
export function maskBounds(alpha: (index: number) => number, width: number, height: number) {
  let left = width,
    top = height,
    right = 0,
    bottom = 0
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (alpha(y * width + x) >= 255) continue
      if (x < left) left = x
      if (y < top) top = y
      if (x + 1 > right) right = x + 1
      if (y + 1 > bottom) bottom = y + 1
    }
  return right > left ? { left, top, right, bottom } : null
}

const toDataUrl = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`
const decodeDataUrl = (value: string) => Buffer.from(value.slice(value.indexOf(',') + 1), 'base64')

export async function prepareMaskedInput(model: string, source: string, mask: string) {
  const bytes = decodeDataUrl(source)
  const metadata = await sharp(bytes, { limitInputPixels: selectionSettings.maxPixels }).metadata()
  const width = metadata.width!
  const height = metadata.height!
  const size = maskedEditSize(model, width, height)
  if ('problem' in size) throw new TypeError(size.problem)
  if (/^gpt-image-2(?:[.-]|$)/.test(model)) {
    const maskPixels = await sharp(decodeDataUrl(mask))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (maskPixels.info.width === width && maskPixels.info.height === height) {
      const channels = maskPixels.info.channels
      const bounds = maskBounds(
        (index) => maskPixels.data[index * channels + channels - 1]!,
        width,
        height,
      )
      const crop = bounds ? maskedEditCrop(width, height, bounds) : null
      if (crop) {
        // 原图与选区原样落库（合成要用整张）；截取在送上游前才做，见 cropMaskedInput。
        const padded = paddedEditSize(crop.width, crop.height)
        return {
          source,
          mask,
          size: `${padded.width}x${padded.height}`,
          originalSize: { width, height },
          crop,
        }
      }
    }
  }
  const { paddedWidth, paddedHeight } = size
  const padding = { top: 0, left: 0, right: paddedWidth - width, bottom: paddedHeight - height }
  if (!padding.right && !padding.bottom)
    return { source, mask, size: `${width}x${height}`, originalSize: { width, height } }
  return {
    // 只在右侧与底部补保留区，原图像素、选区和坐标完全不变；交付时裁掉补边。
    source: toDataUrl(
      await sharp(bytes)
        .extend({ ...padding, extendWith: 'copy' })
        .png()
        .toBuffer(),
    ),
    mask: toDataUrl(
      await sharp(decodeDataUrl(mask))
        .extend({ ...padding, background: '#ffffffff' })
        .png()
        .toBuffer(),
    ),
    size: `${paddedWidth}x${paddedHeight}`,
    originalSize: { width, height },
  }
}

/**
 * 截图模式送上游前的那一步：从原图与选区里截出 `crop`，右、下补到尺寸倍数（原图补边沿用
 * 边缘像素，选区补成保留区）。都是无损 PNG。
 */
export async function cropMaskedInput(source: string, mask: string, crop: MaskedCrop) {
  const padded = paddedEditSize(crop.width, crop.height)
  const padding = {
    top: 0,
    left: 0,
    right: padded.width - crop.width,
    bottom: padded.height - crop.height,
  }
  const cut = async (value: string, extend: ExtendOptions) => {
    const region = await sharp(decodeDataUrl(value), {
      limitInputPixels: selectionSettings.maxPixels,
    })
      .extract(crop)
      .png()
      .toBuffer()
    return toDataUrl(
      padding.right || padding.bottom
        ? await sharp(region).extend(extend).png().toBuffer()
        : region,
    )
  }
  return {
    source: await cut(source, { ...padding, extendWith: 'copy' }),
    mask: await cut(mask, { ...padding, background: '#ffffffff' }),
  }
}

/**
 * 截图模式下提示词里的位置（选区「原图位置」、编号区域、箭头）都按整张原图写的，
 * 送去的却只是其中一块：在提示词后补一句换算说明，免得模型按截图坐标去找对象。
 */
export function croppedPromptNote(
  crop: MaskedCrop,
  originalSize?: { readonly width: number; readonly height: number },
) {
  const whole = originalSize ? `${originalSize.width}×${originalSize.height} 的` : ''
  return `（截图说明：第 1 张输入图只是${whole}整张原图中左上角在 (${crop.left}, ${crop.top})、大小 ${crop.width}×${crop.height} 的一块，右侧与底部可能有补边。上文提到的原图位置、编号区域和箭头坐标都按整张原图计算：像素坐标减去 (${crop.left}, ${crop.top}) 才是这张图里的位置，比例坐标先乘整张原图的宽高再换算。要改的范围以透明选区为准。）`
}

/** 送上游的请求里换上截图与截下的选区、给提示词补上坐标换算说明；其余输入图（参考图）原样保留。 */
export async function cropMaskedUpstream(
  request: {
    readonly input_images?: readonly string[]
    readonly mask?: string
    readonly prompt?: string
  },
  crop: MaskedCrop,
  originalSize?: { readonly width: number; readonly height: number },
) {
  const [source, ...references] = request.input_images ?? []
  if (!source || !request.mask) throw new TypeError('截图模式缺少原图或选区')
  const cropped = await cropMaskedInput(source, request.mask, crop)
  return {
    input_images: [cropped.source, ...references],
    mask: cropped.mask,
    ...(request.prompt
      ? { prompt: `${request.prompt}\n\n${croppedPromptNote(crop, originalSize)}` }
      : {}),
  }
}

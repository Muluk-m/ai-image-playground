import sharp, { type ExtendOptions, type Sharp } from 'sharp'
import { MEDIA_IMAGE_MAX_PIXELS } from '../media-image-limits'
import { maskedEditSettings } from './masked-edit-settings'

/**
 * 这个模型能不能做局部编辑；能做时给出补边后的尺寸。`fits` 为 false 时原尺寸送不上去
 * （超长边、像素过多或过少、长宽比过大），提交时改走缩放截图（见 scaledEditCrop），
 * 不再因为尺寸拒绝。只有模型本身不支持时才给出原因。
 */
export function maskedEditSize(
  model: string,
  width: number,
  height: number,
): { paddedWidth: number; paddedHeight: number; fits: boolean } | { problem: string } {
  const customSize = /^gpt-image-2(?:[.-]|$)/.test(model)
  if (
    !customSize &&
    (!/^gpt-image-1(?:[.-]|$)/.test(model) ||
      !['1024x1024', '1536x1024', '1024x1536'].includes(`${width}x${height}`))
  )
    return { problem: '当前模型不支持这张图的原尺寸局部编辑，请选择 GPT Image 2 系列' }
  if (!customSize) return { paddedWidth: width, paddedHeight: height, fits: true }
  const padded = paddedEditSize(width, height)
  return {
    paddedWidth: padded.width,
    paddedHeight: padded.height,
    fits: !sizeProblem(padded.width, padded.height),
  }
}

/** 局部编辑能处理的原图像素上限：与媒体库收图上限一致，不另设更小的门槛。 */
export const MASKED_INPUT_MAX_PIXELS = MEDIA_IMAGE_MAX_PIXELS

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
  /**
   * 原尺寸送不上去时（太大、太小、太扁）：截下的这一块先等比缩放到这个尺寸（16 的倍数）再送，
   * 回来的图拉回截图原尺寸贴回去。没有这两项就是原尺寸补边送。
   */
  readonly sendWidth?: number
  readonly sendHeight?: number
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

const roundTo = (value: number, multiple: number) =>
  Math.max(multiple, Math.round(value / multiple) * multiple)

/**
 * 原尺寸送不上去时的送法，不设尺寸门槛：
 * - 长宽比超过上游上限时，围着选区截一块长宽比刚好到上限的区域（选区太长放不下就整条送，
 *   缩放时压扁，回来再拉回）；
 * - 截下的区域按比例缩放到约上游原生出图像素（大图缩小、小图放大），宽高取 16 的倍数。
 * 落库的仍是原图与原尺寸选区：交付时生成图拉回截图原尺寸、贴回原位，再只在选区内合成，
 * 所以选区外与原图逐像素相同。`bounds` 是选区外接框，没有选区时传 null（按整张）。
 */
export function scaledEditCrop(
  width: number,
  height: number,
  bounds: { left: number; top: number; right: number; bottom: number } | null,
  budget = UPSTREAM_OUTPUT_PIXELS,
): Required<MaskedCrop> {
  const limits = maskedEditSettings.output
  const ratio = limits.maxAspectRatio
  const box = bounds ?? { left: 0, top: 0, right: width, bottom: height }
  let left = 0,
    top = 0,
    cropWidth = width,
    cropHeight = height
  const place = (center: number, size: number, total: number) =>
    Math.max(0, Math.min(total - size, Math.round(center - size / 2)))
  if (width / height > ratio) {
    const want = Math.max(1, Math.floor(height * ratio))
    if (box.right - box.left <= want) {
      cropWidth = want
      left = place((box.left + box.right) / 2, want, width)
    }
  } else if (height / width > ratio) {
    const want = Math.max(1, Math.floor(width * ratio))
    if (box.bottom - box.top <= want) {
      cropHeight = want
      top = place((box.top + box.bottom) / 2, want, height)
    }
  }
  const multiple = limits.dimensionMultiple
  const scale = Math.sqrt(budget / (cropWidth * cropHeight))
  let sendWidth = roundTo(cropWidth * scale, multiple)
  let sendHeight = roundTo(cropHeight * scale, multiple)
  // 选区本身比上限还长（只能整条送）或取整后略超：压到上限比例，按面积不变分配。
  if (sendWidth / sendHeight > ratio || sendHeight / sendWidth > ratio) {
    const long = Math.sqrt(budget * ratio)
    const short = Math.sqrt(budget / ratio)
    const wide = sendWidth >= sendHeight
    sendWidth = wide
      ? Math.floor(long / multiple) * multiple
      : Math.ceil(short / multiple) * multiple
    sendHeight = wide
      ? Math.ceil(short / multiple) * multiple
      : Math.floor(long / multiple) * multiple
  }
  return { left, top, width: cropWidth, height: cropHeight, sendWidth, sendHeight }
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

/** 按 EXIF 方向把没带方向信息的图（选区）转成与转正后的原图同一坐标。 */
function orient(image: Sharp, orientation: number) {
  switch (orientation) {
    case 2:
      return image.flop()
    case 3:
      return image.rotate(180)
    case 4:
      return image.flip()
    // 同一条 sharp 管线里 flop 先于 rotate 执行：方向 5 = 先顺转 90° 再水平翻 = flop + rotate(270)。
    case 5:
      return image.rotate(270).flop()
    case 6:
      return image.rotate(90)
    case 7:
      return image.rotate(90).flop()
    case 8:
      return image.rotate(270)
    default:
      return image
  }
}

/**
 * 带 EXIF 方向的原图先按方向转正成 PNG（像素不缩放），之后的截取、合成都在转正后的坐标里做，
 * 交付的也是转正后的图。选区一般画在转正后的图上（浏览器按方向显示）；宽高只与未转正的原图
 * 对得上时（服务端分割按原始像素出的选区）一起转正。
 */
async function uprightMaskedInput(source: string, mask: string) {
  const bytes = decodeDataUrl(source)
  const metadata = await sharp(bytes, { limitInputPixels: MASKED_INPUT_MAX_PIXELS }).metadata()
  const orientation = metadata.orientation ?? 1
  if (orientation === 1) return { source, mask, bytes, metadata }
  const upright = await sharp(bytes, { limitInputPixels: MASKED_INPUT_MAX_PIXELS })
    .rotate()
    .png()
    .toBuffer({ resolveWithObject: true })
  const maskBytes = decodeDataUrl(mask)
  const maskMetadata = await sharp(maskBytes).metadata()
  const rawOnly =
    maskMetadata.width === metadata.width &&
    maskMetadata.height === metadata.height &&
    (maskMetadata.width !== upright.info.width || maskMetadata.height !== upright.info.height)
  return {
    source: toDataUrl(upright.data),
    mask: rawOnly
      ? toDataUrl(await orient(sharp(maskBytes).ensureAlpha(), orientation).png().toBuffer())
      : mask,
    bytes: upright.data,
    metadata: { ...metadata, width: upright.info.width, height: upright.info.height },
  }
}

export async function prepareMaskedInput(model: string, original: string, originalMask: string) {
  const { source, mask, bytes, metadata } = await uprightMaskedInput(original, originalMask)
  const width = metadata.width!
  const height = metadata.height!
  const size = maskedEditSize(model, width, height)
  if ('problem' in size) throw new TypeError(size.problem)
  if (/^gpt-image-2(?:[.-]|$)/.test(model)) {
    let bounds: ReturnType<typeof maskBounds> = null
    const maskPixels = await sharp(decodeDataUrl(mask))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (maskPixels.info.width === width && maskPixels.info.height === height) {
      const channels = maskPixels.info.channels
      bounds = maskBounds(
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
    if (!size.fits) {
      // 原尺寸送不上去：截取（必要时）并缩放到上游能收的尺寸，交付时拉回原尺寸再合成。
      const crop = scaledEditCrop(width, height, bounds)
      return {
        source,
        mask,
        size: `${crop.sendWidth}x${crop.sendHeight}`,
        originalSize: { width, height },
        crop,
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
  if (crop.sendWidth && crop.sendHeight) {
    const send = { width: crop.sendWidth, height: crop.sendHeight, fit: 'fill' as const }
    const region = (value: string) =>
      sharp(decodeDataUrl(value), { limitInputPixels: MASKED_INPUT_MAX_PIXELS }).extract({
        left: crop.left,
        top: crop.top,
        width: crop.width,
        height: crop.height,
      })
    return {
      source: toDataUrl(await region(source).resize(send).png().toBuffer()),
      // 选区缩放用最近邻，保持只有「改 / 不改」两种；交付时按原尺寸选区合成，不受这里影响。
      mask: toDataUrl(
        await region(mask)
          .ensureAlpha()
          .resize({ ...send, kernel: 'nearest' })
          .png()
          .toBuffer(),
      ),
    }
  }
  const padded = paddedEditSize(crop.width, crop.height)
  const padding = {
    top: 0,
    left: 0,
    right: padded.width - crop.width,
    bottom: padded.height - crop.height,
  }
  const cut = async (value: string, extend: ExtendOptions) => {
    const region = await sharp(decodeDataUrl(value), {
      limitInputPixels: MASKED_INPUT_MAX_PIXELS,
    })
      .extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
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

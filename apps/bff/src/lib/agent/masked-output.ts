import sharp from 'sharp'
import { labelComponents } from './mask-regions'
import { estimateTranslation, inspectMaskedAlignment } from './masked-alignment'
import { inwardMaskDistance } from './masked-boundary'
import { maskedEditSettings } from './masked-edit-settings'
import { type MaskedCrop, paddedEditSize } from './masked-input'
import { selectionSettings } from './selection-settings'

export class MaskedOutputError extends Error {}

type Pixels = Awaited<ReturnType<typeof pixels>>

async function pixels(bytes: Uint8Array) {
  const image = sharp(bytes, { limitInputPixels: selectionSettings.maxPixels })
  const metadata = await image.metadata()
  if ((metadata.orientation ?? 1) !== 1 || (metadata.pages ?? 1) !== 1)
    throw new MaskedOutputError('生成图的方向或帧数无法与选区对应，未应用修改，可重试')
  return image.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })
}

/**
 * 生成图的透明通道一律不认：只取颜色，当它完全不透明。上游偶尔回一张带柔和透明度的 RGBA
 * （没有一个像素完全不透明），按透明度合成会把选区里的结果变成半透明，对齐校验也会因为
 * 找不到不透明像素而整张拒收。返回原来有多少像素不是完全不透明，记进检查结果。
 */
function ignoreCandidateAlpha(image: Pixels): number {
  let translucent = 0
  for (let offset = 3; offset < image.data.length; offset += 4)
    if (image.data[offset] !== 255) {
      translucent++
      image.data[offset] = 255
    }
  return translucent
}

/** 选区里的一个连通块：确认时的一个编号区域（或它的一部分）。 */
interface EditRegion {
  /** 这一块的全部像素下标（含羽化带）。 */
  readonly pixels: Int32Array
  /** 用来判断「改了没有」的像素：羽化带以内；块太细没有内部时就是全部。 */
  readonly core: Int32Array
}

/** 一组像素的变化量：颜色差超过阈值的比例，与每像素最大通道差的均值。 */
interface ChangeStats {
  readonly fraction: number
  readonly meanDelta: number
}

function changeStats(
  source: Uint8Array,
  generated: Uint8Array,
  indices: ArrayLike<number>,
  stride = 1,
): ChangeStats {
  const { changedDelta } = maskedEditSettings.regions
  let changed = 0,
    total = 0,
    sum = 0
  for (let at = 0; at < indices.length; at += stride) {
    const offset = indices[at]! * 4
    const delta = Math.max(
      Math.abs(generated[offset]! - source[offset]!),
      Math.abs(generated[offset + 1]! - source[offset + 1]!),
      Math.abs(generated[offset + 2]! - source[offset + 2]!),
    )
    total++
    sum += delta
    if (delta > changedDelta) changed++
  }
  return total
    ? { fraction: changed / total, meanDelta: sum / total }
    : { fraction: 0, meanDelta: 0 }
}

/**
 * 候选图在某一块里有没有真的改，按相对量判断：与这张候选在保护区里的「重画噪声」比（保护区本应
 * 一模一样，那里的差就是模型整图重画的底噪）。明显超出底噪的大色差像素够多（换了东西、去掉污渍），
 * 或者整体色差均值抬高（颜色稍微暖一点、亮一点），都算改了。只有和底噪差不多时才算「没改到」。
 */
function regionChanged(stats: ChangeStats, floor: ChangeStats): boolean {
  const { minChangedFraction, minMeanLift } = maskedEditSettings.regions
  return (
    stats.fraction - floor.fraction >= minChangedFraction ||
    stats.meanDelta - floor.meanDelta >= minMeanLift
  )
}

/**
 * 上游常不按请求的尺寸出图，而是按自己的像素档位（约 1.57MP）等比放缩：方图一律 1254×1254、
 * 3840×2160 只回 1672×941。一律拉回工作尺寸、照常交付，不因放大倍数或宽高比拒绝：
 * - 宽高比一致（等比铺满后只差取整的 2 像素以内）：直接缩放到工作尺寸；
 * - 宽高比不同：先等比铺满工作尺寸，再按选区中心在原图里的相对位置裁出工作尺寸（选区居中时就是
 *   居中裁切），让选区附近的内容尽量对上。
 * 选区外随后一律用原图像素（见 transform），所以无论怎么缩放裁切，选区外 0 像素变化。
 * 返回 `fit`：0 未缩放，1 等比缩放，2 铺满后裁切。
 */
export function upstreamFit(
  width: number,
  height: number,
  generatedWidth: number,
  generatedHeight: number,
  focus: { readonly x: number; readonly y: number },
) {
  if (generatedWidth === width && generatedHeight === height)
    return { fit: 0, coverWidth: width, coverHeight: height, left: 0, top: 0 } as const
  const scale = Math.max(width / generatedWidth, height / generatedHeight)
  const coverWidth = Math.max(width, Math.round(generatedWidth * scale))
  const coverHeight = Math.max(height, Math.round(generatedHeight * scale))
  if (coverWidth - width <= 2 && coverHeight - height <= 2)
    return { fit: 1, coverWidth: width, coverHeight: height, left: 0, top: 0 } as const
  const offset = (at: number, size: number, cover: number) =>
    Math.min(cover - size, Math.max(0, Math.round(at * (cover / size - 1))))
  return {
    fit: 2,
    coverWidth,
    coverHeight,
    left: offset(focus.x, width, coverWidth),
    top: offset(focus.y, height, coverHeight),
  } as const
}

/**
 * 只在原图坐标内合成：候选拉回原尺寸（见 upstreamFit），选区内按羽化带混合，选区外逐像素用原图。
 * 对齐与「区域没改到」只核对、记进 inspection，不拒收、不重试（重试要平台额外付上游的钱）。
 */
/**
 * 截图模式：把（已统一到补边截图尺寸的）生成图里截图那一块贴回整张原图的截取位置，
 * 截图外原样。之后照常只在选区内合成，所以截图外、选区外都与原图逐像素相同。
 */
export function placeCrop(source: Pixels, generated: Pixels, crop: MaskedCrop): Pixels {
  const { width } = source.info
  const stride = generated.info.width * 4
  const data = Buffer.from(source.data)
  for (let row = 0; row < crop.height; row++)
    data.set(
      generated.data.subarray(row * stride, row * stride + crop.width * 4),
      ((crop.top + row) * width + crop.left) * 4,
    )
  return { data, info: source.info }
}

export async function protectMaskedOutput(
  sourceDataUrl: string,
  maskDataUrl: string,
  originalSize?: { width: number; height: number },
  crop?: MaskedCrop,
) {
  const decode = (value: string) => Buffer.from(value.slice(value.indexOf(',') + 1), 'base64')
  const source = await pixels(decode(sourceDataUrl))
  const maskBytes = decode(maskDataUrl)
  if (!(await sharp(maskBytes).metadata()).hasAlpha)
    throw new MaskedOutputError('选区缺少透明通道，未提交编辑')
  const mask = await pixels(maskBytes)
  const { width, height } = source.info
  if (width !== mask.info.width || height !== mask.info.height)
    throw new MaskedOutputError('选区尺寸与原图不一致，未提交编辑')
  if (!mask.data.some((value, index) => index % 4 === 3 && value < 255))
    throw new MaskedOutputError('没有选中编辑区域，未提交编辑')
  if (
    crop &&
    (crop.left < 0 ||
      crop.top < 0 ||
      crop.width <= 0 ||
      crop.height <= 0 ||
      crop.left + crop.width > width ||
      crop.top + crop.height > height)
  )
    throw new MaskedOutputError('截取区域超出原图，未提交编辑')
  // 上游实际收到的画幅：截图模式是补边后的截图，整图模式就是（已补边的）原图。
  const upstream = crop ? paddedEditSize(crop.width, crop.height) : { width, height }
  const featherPixels =
    Math.min(width, height) >= maskedEditSettings.boundary.minImageEdge
      ? maskedEditSettings.boundary.featherPixels
      : 0
  const boundary = featherPixels
    ? inwardMaskDistance(mask.data, width, height, featherPixels)
    : undefined

  // 选区按连通块分成区域：确认时的每个编号区域一般各是一块。太小的碎块不单独核对。
  const editAlpha = new Uint8Array(width * height)
  for (let index = 0; index < editAlpha.length; index++)
    editAlpha[index] = mask.data[index * 4 + 3]! < 255 ? 1 : 0
  let minX = width,
    minY = height,
    maxX = 0,
    maxY = 0
  for (let index = 0; index < editAlpha.length; index++) {
    if (!editAlpha[index]) continue
    const x = index % width,
      y = (index - x) / width
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const focus = { x: (minX + maxX + 1) / 2, y: (minY + maxY + 1) / 2 }
  const components = labelComponents(editAlpha, true, width, height, true)
  const regions: EditRegion[] = []
  {
    const members: number[][] = components.areas.map(() => [])
    for (let index = 0; index < editAlpha.length; index++) {
      const label = components.labels[index]!
      if (label) members[label]!.push(index)
    }
    for (const list of members) {
      if (list.length < maskedEditSettings.regions.minPixels) continue
      const core = boundary ? list.filter((index) => boundary[index] === featherPixels) : list
      regions.push({
        pixels: Int32Array.from(list),
        core: Int32Array.from(
          core.length >= maskedEditSettings.regions.minPixels / 4 ? core : list,
        ),
      })
    }
  }

  /** 读一张候选，统一成工作尺寸、完全不透明，并记下保护区是否仍在原位（只记录，不拒收）。 */
  const fitCandidate = async (bytes: Uint8Array) => {
    let generated = await pixels(bytes)
    const candidateWidth = generated.info.width,
      candidateHeight = generated.info.height
    const translucentPixels = ignoreCandidateAlpha(generated)
    const fit = upstreamFit(
      upstream.width,
      upstream.height,
      candidateWidth,
      candidateHeight,
      crop ? { x: focus.x - crop.left, y: focus.y - crop.top } : focus,
    )
    if (fit.fit) {
      let resized = sharp(generated.data, { raw: generated.info }).resize(
        fit.coverWidth,
        fit.coverHeight,
        { fit: 'fill' },
      )
      if (fit.fit === 2) resized = resized.extract({ left: fit.left, top: fit.top, ...upstream })
      generated = await pixels(await resized.png().toBuffer())
      ignoreCandidateAlpha(generated)
    }
    if (crop) generated = placeCrop(source, generated, crop)
    const alignment = inspectMaskedAlignment(source.data, generated.data, mask.data, width, height)
    const translation = estimateTranslation(source.data, generated.data, mask.data, width, height)
    return {
      generated,
      alignment,
      translation,
      fit,
      candidateWidth,
      candidateHeight,
      translucentPixels,
    }
  }

  // 保护区像素（底噪取样用）：至多取约 20 万个，大图也只花几毫秒。
  const protectedIndices: number[] = []
  for (let index = 0; index < editAlpha.length; index++)
    if (!editAlpha[index]) protectedIndices.push(index)
  const floorStride = Math.max(1, Math.ceil(protectedIndices.length / 200_000))
  /** 这张候选在保护区里的重画底噪（合成前，保护区本应与原图完全相同）。 */
  const noiseFloor = (generated: Pixels) =>
    changeStats(source.data, generated.data, protectedIndices, floorStride)

  /** 逐区域核对有没有真的改（只记录）：与这张候选在保护区里的重画底噪比。 */
  const inspectRegions = (generated: Pixels) => {
    const floor = noiseFloor(generated)
    return {
      unchanged: regions.filter(
        (region) => !regionChanged(changeStats(source.data, generated.data, region.core), floor),
      ).length,
      noiseFraction: floor.fraction,
      noiseMeanDelta: floor.meanDelta,
    }
  }

  const transform = async (candidate: Uint8Array) => {
    try {
      const fitted = await fitCandidate(candidate)
      const { generated, alignment, translation, fit, candidateWidth, candidateHeight } = fitted
      const regionCheck = inspectRegions(generated)
      const output = Buffer.from(source.data)
      let outsideChangedPixels = 0
      let insideChangedPixels = 0
      for (let offset = 0; offset < output.length; offset += 4) {
        const amount =
          (1 - mask.data[offset + 3]! / 255) *
          (boundary ? boundary[offset / 4]! / featherPixels : 1)
        const changed =
          generated.data[offset] !== source.data[offset] ||
          generated.data[offset + 1] !== source.data[offset + 1] ||
          generated.data[offset + 2] !== source.data[offset + 2] ||
          generated.data[offset + 3] !== source.data[offset + 3]
        if (amount === 0) {
          if (changed) outsideChangedPixels++
          continue
        }
        if (changed) insideChangedPixels++
        const sourceAlpha = source.data[offset + 3]! / 255
        // 候选已按完全不透明处理（见 ignoreCandidateAlpha）。
        const candidateAlpha = generated.data[offset + 3]! / 255
        const alpha = sourceAlpha * (1 - amount) + candidateAlpha * amount
        for (let channel = 0; channel < 3; channel++) {
          output[offset + channel] =
            alpha === 0
              ? 0
              : Math.round(
                  (source.data[offset + channel]! * sourceAlpha * (1 - amount) +
                    generated.data[offset + channel]! * candidateAlpha * amount) /
                    alpha,
                )
        }
        output[offset + 3] = Math.round(alpha * 255)
      }
      let image = sharp(output, { raw: { width, height, channels: 4 } })
      if (originalSize) image = image.extract({ left: 0, top: 0, ...originalSize })
      return {
        // 无损 PNG 带自适应滤波：4K 照片从约 11.6MB 降到约 7.2MB（像素逐字节相同），
        // 不然原尺寸交付会超出媒体库单张图片的字节上限（测试环境 10MiB），归档一直重试。
        bytes: await image.png({ adaptiveFiltering: true }).toBuffer(),
        mime: 'image/png',
        inspection: {
          outsideChangedPixels,
          insideChangedPixels,
          width: originalSize?.width ?? width,
          height: originalSize?.height ?? height,
          texturedRegions: alignment.texturedRegions,
          matchedRegions: alignment.matchedRegions,
          matchedQuadrants: alignment.matchedQuadrants,
          rescaled: Number(fit.fit !== 0),
          fit: fit.fit,
          cropLeft: fit.left,
          cropTop: fit.top,
          alignmentAccepted: Number(alignment.accepted),
          translationAligned: Number(translation.aligned),
          translationDx: translation.dx,
          translationDy: translation.dy,
          boundaryFeatherPixels: featherPixels,
          candidateWidth,
          candidateHeight,
          workingWidth: width,
          workingHeight: height,
          // 选区里的放大倍数（>1 就是放大）：截图模式按截图算。
          scaleX: upstream.width / candidateWidth,
          scaleY: upstream.height / candidateHeight,
          maskedCrop: Number(Boolean(crop)),
          maskedCropLeft: crop?.left ?? 0,
          maskedCropTop: crop?.top ?? 0,
          maskedCropWidth: crop?.width ?? width,
          maskedCropHeight: crop?.height ?? height,
          translucentPixels: fitted.translucentPixels,
          regions: regions.length,
          regionsUnchanged: regionCheck.unchanged,
          protectedNoiseFraction: Number(regionCheck.noiseFraction.toFixed(4)),
          protectedNoiseMeanDelta: Number(regionCheck.noiseMeanDelta.toFixed(2)),
        },
      }
    } catch (error) {
      if (error instanceof MaskedOutputError) throw error
      if (error instanceof Error && error.name === 'AbortError') throw error
      throw new MaskedOutputError('生成图无法与原图选区对应；候选已保留，未应用修改，可重试', {
        cause: error,
      })
    }
  }

  return transform
}

import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { labelComponents } from './mask-regions'
import { estimateTranslation, inspectMaskedAlignment } from './masked-alignment'
import { inwardMaskDistance } from './masked-boundary'
import { maskedEditSettings } from './masked-edit-settings'
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
 * 只重画某几块时交给上游的蒙版：同尺寸 PNG，这几块透明（重画），其余全部不透明（保留）。
 */
async function regionsMaskDataUrl(regions: readonly EditRegion[], width: number, height: number) {
  const rgba = Buffer.alloc(width * height * 4, 255)
  for (const region of regions) for (const index of region.pixels) rgba[index * 4 + 3] = 0
  const png = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer()
  return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, alpha: rgba }
}

interface MaskedOutputOptions {
  /**
   * 某些区域生成后没变（模型在选区里照原样画回来）时，只针对这些区域再生成一次。
   * 参数是只把这些区域标成透明的蒙版（工作尺寸，与输入同格式）；返回上游的一张候选原图，
   * 拿不到就返回 null。不提供时只核对、不重试。
   */
  readonly repair?: (maskDataUrl: string, attempt: number) => Promise<Uint8Array | null>
  /**
   * 这一次确认（所有候选合计）最多重试几次，默认取 `regions.maxRetries`（目前 0：只核对、记日志，
   * 不额外向上游要图）。重试的费用由平台承担、不向用户计费，所以上限按整次确认算。
   */
  readonly maxRetries?: number
}

/**
 * 上游常不按请求的尺寸出图，而是按自己的像素档位（约 1.57MP）等比放缩：方图一律 1254×1254、
 * 768×1024 回 1086×1448。宽高比对得上（只差取整）就缩回请求尺寸再核对、合成：
 * - 上游图比请求大（缩小回去，已知 1.22–1.45×）：不损清晰度，至多 `maxDownscaleFactor`；
 * - 上游图比请求小（要放大回去）：选区内会比选区外的原图像素糊，只容取整级别的 `maxUpscaleFactor`。
 *   大原图（如 3840×2160 只回 1672×941，要放大 2.3×）因此拒绝，提示分辨率受限、可重试。
 * 宽高比不对说明画面被裁或拉伸过，一律拒绝。
 */
export function upstreamSizeProblem(
  width: number,
  height: number,
  generatedWidth: number,
  generatedHeight: number,
): 'mismatch' | 'upscale' | 'downscale' | null {
  const limits = maskedEditSettings.rescale
  const sx = generatedWidth / width,
    sy = generatedHeight / height
  // 宽高比不对，或差了 4 倍以上（不是任何已知档位，是另一套坐标）：不当作分辨率问题。
  if (Math.abs(sx / sy - 1) > limits.maxAspectDifference || Math.max(sx, sy, 1 / sx, 1 / sy) > 4)
    return 'mismatch'
  if (Math.max(1 / sx, 1 / sy) > limits.maxUpscaleFactor) return 'upscale'
  if (Math.max(sx, sy) > limits.maxDownscaleFactor) return 'downscale'
  return null
}

/**
 * 缩放过的候选要有足够的原位纹理证据才可贴回。纹理多时要求分散（够多的格、够多的象限）；换背景时
 * 保护区常只剩一个小而平滑的主体，凑不够那么多格——这时退而要求每一个有纹理的保护格都对得上，
 * 且至少有 `minAllMatchedRegions` 格（`local`），再由 `estimateTranslation` 核对主体轮廓没有整体平移。
 */
export function rescaleEvidence(alignment: {
  readonly texturedRegions: number
  readonly matchedRegions: number
  readonly matchedQuadrants: number
}): 'dispersed' | 'local' | null {
  const limits = maskedEditSettings.rescale
  if (
    alignment.texturedRegions >= limits.minTexturedRegions &&
    alignment.matchedQuadrants >= limits.minMatchedQuadrants
  )
    return 'dispersed'
  if (
    alignment.texturedRegions >= limits.minAllMatchedRegions &&
    alignment.matchedRegions === alignment.texturedRegions
  )
    return 'local'
  return null
}

/** 只在原图坐标内合成；上游等比放缩过的候选（宽高比一致）缩回原尺寸后，须有分散的保护区纹理证据才可校正。 */
export async function protectMaskedOutput(
  sourceDataUrl: string,
  maskDataUrl: string,
  originalSize?: { width: number; height: number },
  options: MaskedOutputOptions = {},
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

  /** 读一张候选，统一成工作尺寸、完全不透明，并核对保护区仍在原位。 */
  const fitCandidate = async (bytes: Uint8Array, protectedAlpha: Uint8Array) => {
    let generated = await pixels(bytes)
    const candidateWidth = generated.info.width,
      candidateHeight = generated.info.height
    const translucentPixels = ignoreCandidateAlpha(generated)
    const rescaled = generated.info.width !== width || generated.info.height !== height
    if (rescaled) {
      const problem = upstreamSizeProblem(
        width,
        height,
        generated.info.width,
        generated.info.height,
      )
      if (problem === 'upscale')
        throw new MaskedOutputError(
          `分辨率受限：生成图只有 ${generated.info.width}×${generated.info.height}，放大回原图会让选区内明显变糊；候选已保留，未应用修改。可先把原图缩小后再改`,
        )
      if (problem)
        throw new MaskedOutputError(
          '生成图尺寸与原图不一致，无法保护选区外内容；候选已保留，未应用修改，可重试',
        )
      // 此时只是待验证的尺度假设；没有足够原位纹理证据就拒绝，不盲目贴回。
      generated = await pixels(
        await sharp(generated.data, { raw: generated.info })
          .resize(width, height, { fit: 'fill' })
          .png()
          .toBuffer(),
      )
      ignoreCandidateAlpha(generated)
    }
    const alignment = inspectMaskedAlignment(
      source.data,
      generated.data,
      protectedAlpha,
      width,
      height,
    )
    // 纹理不够分散（只凭局部几格，或保护区几乎没有纹理）时，块相关看不出几像素的整体平移：
    // 再核一次主体轮廓有没有挪位。缩放过的候选还必须至少有局部证据。
    const evidence = rescaleEvidence(alignment)
    if (
      !alignment.accepted ||
      (rescaled && !evidence) ||
      (evidence !== 'dispersed' &&
        !estimateTranslation(source.data, generated.data, protectedAlpha, width, height).aligned)
    )
      throw new MaskedOutputError('生成图与原图的位置对应无法确认；候选已保留，未应用修改，可重试')
    return {
      generated,
      alignment,
      rescaled,
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

  let retryBudget = Math.max(0, options.maxRetries ?? maskedEditSettings.regions.maxRetries)

  /**
   * 逐区域核对；没变的区域只对它们再要一张，换进这些区域的像素。整次确认合计至多重试
   * `retryBudget` 次。重试的图同样要过对齐校验，过不了就当这一次没拿到。
   */
  const repairRegions = async (generated: Pixels) => {
    const floor = noiseFloor(generated)
    const isChanged = (data: Uint8Array, region: EditRegion) =>
      regionChanged(changeStats(source.data, data, region.core), floor)
    let unchanged = regions.filter((region) => !isChanged(generated.data, region))
    const initiallyUnchanged = unchanged.length
    let retries = 0
    while (unchanged.length && options.repair && retryBudget > 0) {
      retryBudget--
      retries++
      const retryMask = await regionsMaskDataUrl(unchanged, width, height)
      const bytes = await options.repair(retryMask.dataUrl, retries).catch((error) => {
        if (error instanceof Error && error.name === 'AbortError') throw error
        return null
      })
      if (!bytes) continue
      const retry = await fitCandidate(bytes, retryMask.alpha).catch(() => null)
      if (!retry) continue
      for (const region of unchanged) {
        if (!isChanged(retry.generated.data, region)) continue
        for (const index of region.pixels) {
          const offset = index * 4
          generated.data[offset] = retry.generated.data[offset]!
          generated.data[offset + 1] = retry.generated.data[offset + 1]!
          generated.data[offset + 2] = retry.generated.data[offset + 2]!
        }
      }
      unchanged = unchanged.filter((region) => !isChanged(generated.data, region))
    }
    return {
      initiallyUnchanged,
      retries,
      stillUnchanged: unchanged.length,
      noiseFraction: floor.fraction,
      noiseMeanDelta: floor.meanDelta,
    }
  }

  const transform = async (candidate: Uint8Array) => {
    try {
      const fitted = await fitCandidate(candidate, mask.data)
      const { generated, alignment, rescaled, candidateWidth, candidateHeight } = fitted
      const repaired = await repairRegions(generated)
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
        bytes: await image.png().toBuffer(),
        mime: 'image/png',
        inspection: {
          outsideChangedPixels,
          insideChangedPixels,
          width: originalSize?.width ?? width,
          height: originalSize?.height ?? height,
          texturedRegions: alignment.texturedRegions,
          matchedRegions: alignment.matchedRegions,
          matchedQuadrants: alignment.matchedQuadrants,
          rescaled: Number(rescaled),
          boundaryFeatherPixels: featherPixels,
          candidateWidth,
          candidateHeight,
          workingWidth: width,
          workingHeight: height,
          scaleX: width / candidateWidth,
          scaleY: height / candidateHeight,
          translucentPixels: fitted.translucentPixels,
          regions: regions.length,
          regionsUnchanged: repaired.initiallyUnchanged,
          regionRetries: repaired.retries,
          regionsStillUnchanged: repaired.stillUnchanged,
          protectedNoiseFraction: Number(repaired.noiseFraction.toFixed(4)),
          protectedNoiseMeanDelta: Number(repaired.noiseMeanDelta.toFixed(2)),
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

  // 归档在存储出错时会把同一张候选再合成一遍；有重试时按内容记住结果，不重复花上游的钱。
  if (!options.repair) return transform
  const results = new Map<string, ReturnType<typeof transform>>()
  return (candidate: Uint8Array) => {
    const key = createHash('sha256').update(candidate).digest('hex')
    let result = results.get(key)
    if (!result) {
      result = transform(candidate)
      results.set(key, result)
      result.catch(() => results.delete(key))
    }
    return result
  }
}

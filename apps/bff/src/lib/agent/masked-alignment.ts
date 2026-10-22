import { maskedEditSettings } from './masked-edit-settings'

/** 保护区的局部纹理应仍在原位；这是错位筛查，不是编辑语义验收。 */
export function inspectMaskedAlignment(
  source: Uint8Array,
  candidate: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
) {
  const policy = maskedEditSettings.alignment
  const stepX = Math.max(1, Math.ceil(width / policy.gridSize))
  const stepY = Math.max(1, Math.ceil(height / policy.gridSize))
  // 比较低频结构，避免 JPEG 噪声、细纹理重绘被当作整图错位。
  const sampleSize = Math.max(1, Math.ceil(Math.min(width, height) / policy.analysisMaxEdge))
  let textured = 0
  let matched = 0
  const matchedQuadrants = new Set<number>()
  let protectedPixels = 0
  let difference = 0
  const grey = (data: Uint8Array, index: number) =>
    (data[index]! + data[index + 1]! * 2 + data[index + 2]!) / 4
  for (let top = 0; top < height; top += stepY) {
    for (let left = 0; left < width; left += stepX) {
      let sumA = 0,
        sumB = 0,
        sumAA = 0,
        sumBB = 0,
        sumAB = 0,
        count = 0,
        excluded = false
      for (let y = top; y < Math.min(height, top + stepY); y += sampleSize) {
        for (let x = left; x < Math.min(width, left + stepX); x += sampleSize) {
          let a = 0,
            b = 0,
            protectedA = 0,
            protectedB = 0,
            samples = 0
          for (let sy = y; sy < Math.min(height, top + stepY, y + sampleSize); sy++) {
            for (let sx = x; sx < Math.min(width, left + stepX, x + sampleSize); sx++) {
              const offset = (sy * width + sx) * 4
              if (mask[offset + 3] !== 255) {
                excluded = true
                continue
              }
              protectedPixels++
              protectedA += grey(source, offset)
              protectedB += grey(candidate, offset)
              if (source[offset + 3] !== 255 || candidate[offset + 3] !== 255) {
                excluded = true
                continue
              }
              a += grey(source, offset)
              b += grey(candidate, offset)
              samples++
            }
          }
          // 块大小与保护像素数量加权，平坦区域也使用同一份低频证据。
          difference += Math.abs(protectedA - protectedB)
          if (!samples) continue
          a /= samples
          b /= samples
          count++
          sumA += a
          sumB += b
          sumAA += a * a
          sumBB += b * b
          sumAB += a * b
        }
      }
      if (excluded || count < 2) continue
      const varA = sumAA - (sumA * sumA) / count
      const varB = sumBB - (sumB * sumB) / count
      if (varA / count < policy.minVariance) continue
      textured++
      const correlation = varB <= 0 ? 0 : (sumAB - (sumA * sumB) / count) / Math.sqrt(varA * varB)
      if (correlation >= policy.minCorrelation) {
        matched++
        matchedQuadrants.add((top < height / 2 ? 0 : 2) + (left < width / 2 ? 0 : 1))
      }
    }
  }
  const accepted =
    protectedPixels === 0 ||
    (textured > 0
      ? matched / textured >= policy.minMatchedFraction
      : difference / protectedPixels <= policy.maxFlatDifference)
  return {
    accepted,
    texturedRegions: textured,
    matchedRegions: matched,
    matchedQuadrants: matchedQuadrants.size,
  }
}

/** 平移估计的分析尺寸（长边）、搜索半径与容差，都按分析尺寸的像素计。 */
const SHIFT_ANALYSIS_EDGE = 512
const SHIFT_SEARCH = 12
const SHIFT_TOLERANCE = 1

/**
 * 候选相对原图整体平移了多少（分析像素）。在保护区里比较两边的梯度幅值，在 ±`SHIFT_SEARCH`
 * 内找差异最小的偏移。保护区只是一个平滑小主体时，粗网格的块相关看不出几像素的平移，
 * 512 长边下主体内部的反光、高光沿与排水口还看得出来。
 */
export function estimateTranslation(
  source: Uint8Array,
  candidate: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
): { readonly dx: number; readonly dy: number; readonly aligned: boolean } {
  const scale = Math.max(1, Math.max(width, height) / SHIFT_ANALYSIS_EDGE)
  const w = Math.max(1, Math.round(width / scale))
  const h = Math.max(1, Math.round(height / scale))
  const shrink = (data: Uint8Array) => {
    const grey = new Float32Array(w * h)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const sx = Math.min(width - 1, Math.floor((x + 0.5) * scale))
        const sy = Math.min(height - 1, Math.floor((y + 0.5) * scale))
        const offset = (sy * width + sx) * 4
        grey[y * w + x] = (data[offset]! + data[offset + 1]! * 2 + data[offset + 2]!) / 4
      }
    const gradient = new Float32Array(w * h)
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x
        gradient[i] = Math.abs(grey[i + 1]! - grey[i - 1]!) + Math.abs(grey[i + w]! - grey[i - w]!)
      }
    return gradient
  }
  const a = shrink(source)
  const b = shrink(candidate)
  // 只看保护区本身：换背景时保护区外的内容本来就该变，拿它对齐会被新背景带偏。
  const region: number[] = []
  for (let y = SHIFT_SEARCH + 1; y < h - SHIFT_SEARCH - 1; y++)
    for (let x = SHIFT_SEARCH + 1; x < w - SHIFT_SEARCH - 1; x++) {
      const sx = Math.min(width - 1, Math.floor((x + 0.5) * scale))
      const sy = Math.min(height - 1, Math.floor((y + 0.5) * scale))
      if (mask[(sy * width + sx) * 4 + 3] === 255) region.push(y * w + x)
    }
  if (!region.length) return { dx: 0, dy: 0, aligned: true }
  // 保护区很大时均匀抽样，搜索代价封顶（625 个偏移 × 至多约 6 万点）。
  const stride = Math.ceil(region.length / 60_000)
  const points = stride > 1 ? region.filter((_, index) => index % stride === 0) : region
  let best = { dx: 0, dy: 0, error: Number.POSITIVE_INFINITY }
  for (let dy = -SHIFT_SEARCH; dy <= SHIFT_SEARCH; dy++)
    for (let dx = -SHIFT_SEARCH; dx <= SHIFT_SEARCH; dx++) {
      let error = 0
      const shift = dy * w + dx
      for (const index of points) error += Math.abs(a[index]! - b[index + shift]!)
      // 同分时偏向更小的偏移，平坦处不会凭噪声挑出一个远处的解。
      if (
        error < best.error - 1e-6 ||
        (Math.abs(error - best.error) <= 1e-6 &&
          Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy))
      )
        best = { dx, dy, error }
    }
  return {
    dx: best.dx,
    dy: best.dy,
    aligned: Math.abs(best.dx) <= SHIFT_TOLERANCE && Math.abs(best.dy) <= SHIFT_TOLERANCE,
  }
}

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
            samples = 0
          for (let sy = y; sy < Math.min(height, top + stepY, y + sampleSize); sy++) {
            for (let sx = x; sx < Math.min(width, left + stepX, x + sampleSize); sx++) {
              const offset = (sy * width + sx) * 4
              if (mask[offset + 3] !== 255) {
                excluded = true
                continue
              }
              protectedPixels++
              difference += Math.abs(grey(source, offset) - grey(candidate, offset))
              if (source[offset + 3] !== 255 || candidate[offset + 3] !== 255) {
                excluded = true
                continue
              }
              a += grey(source, offset)
              b += grey(candidate, offset)
              samples++
            }
          }
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

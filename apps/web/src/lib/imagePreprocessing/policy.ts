/** Transport budgets are independent of the BFF's original-media admission limits. */
export const IMAGE_PREPROCESSING = {
  maxInputBytes: 100 * 1024 * 1024,
  maxDecodePixels: 64_000_000,
  maxDecodeSide: 32_768,
  maxEdge: 2048,
  maxPixels: 2048 * 2048,
  maxBytes: 2 * 1024 * 1024,
  quality: 0.9,
  timeoutMs: 45_000,
} as const

export interface ImagePreparationLimits {
  maxBytes: number
  maxPixels: number
}
export interface PreparedImage {
  data: ArrayBuffer
  contentType: string
  width: number
  height: number
  originalBytes: number
}
export function preparedDimensions(width: number, height: number, limits: ImagePreparationLimits) {
  const maxPixels = Math.min(limits.maxPixels, IMAGE_PREPROCESSING.maxPixels)
  const scale = Math.min(
    1,
    IMAGE_PREPROCESSING.maxEdge / Math.max(width, height),
    Math.sqrt(maxPixels / (width * height)),
  )
  let fittedWidth = Math.max(1, Math.floor(width * scale))
  let fittedHeight = Math.max(1, Math.floor(height * scale))
  // Pinning the short side to one pixel can otherwise exceed an area cap on very thin images.
  if (fittedWidth * fittedHeight > maxPixels) {
    if (fittedWidth >= fittedHeight) fittedWidth = Math.max(1, Math.floor(maxPixels / fittedHeight))
    else fittedHeight = Math.max(1, Math.floor(maxPixels / fittedWidth))
  }
  return { width: fittedWidth, height: fittedHeight }
}

import { encodeRgbaPng, toPngDataUrl } from './pngEncode'
import type { MaskPixels, ProductAlpha } from './types'

export const DEFAULT_MASK_THRESHOLD = 0.5
export const DEFAULT_MASK_FEATHER = 2

/** 两次盒模糊≈三角核，比单次少一点方块感。 */
const BLUR_PASSES = 2

export interface InpaintMaskOptions {
  /** 0~1，低于此值的 alpha 归为背景。 */
  threshold?: number
  /** 羽化半径（像素），0 = 硬边。 */
  feather?: number
}

function blurAxis(
  src: Float32Array,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean,
): Float32Array {
  const out = new Float32Array(src.length)
  const outer = horizontal ? height : width
  const inner = horizontal ? width : height
  const prefix = new Float32Array(inner + 1)
  const at = (o: number, i: number) => (horizontal ? o * width + i : i * width + o)

  for (let o = 0; o < outer; o++) {
    for (let i = 0; i < inner; i++) prefix[i + 1] = prefix[i] + src[at(o, i)]
    for (let i = 0; i < inner; i++) {
      const lo = Math.max(0, i - radius)
      const hi = Math.min(inner - 1, i + radius)
      out[at(o, i)] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1)
    }
  }
  return out
}

function applyFeather(
  src: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  let out = src
  for (let pass = 0; pass < BLUR_PASSES; pass++) {
    out = blurAxis(out, width, height, radius, true)
    out = blurAxis(out, width, height, radius, false)
  }
  return out
}

/**
 * 产品 alpha → 遮罩像素：产品不透明（保留），背景透明（重绘），边缘羽化。
 * RGB 恒为白，语义全在 alpha 上——原生 inpaint 只读 alpha。
 */
export function alphaToMaskPixels(
  matte: ProductAlpha,
  options: InpaintMaskOptions = {},
): MaskPixels {
  const { width, height } = matte
  const total = width * height
  const cutoff = (options.threshold ?? DEFAULT_MASK_THRESHOLD) * 255
  const feather = Math.max(0, Math.round(options.feather ?? DEFAULT_MASK_FEATHER))

  const binary = new Float32Array(total)
  for (let i = 0; i < total; i++) binary[i] = matte.alpha[i] >= cutoff ? 255 : 0
  const values = feather > 0 ? applyFeather(binary, width, height, feather) : binary

  const data = new Uint8ClampedArray(total * 4)
  for (let i = 0; i < total; i++) {
    data[i * 4] = 255
    data[i * 4 + 1] = 255
    data[i * 4 + 2] = 255
    data[i * 4 + 3] = Math.round(values[i])
  }
  return { data, width, height }
}

/** 与 MaskEditorModal 一致的产出：与原图同尺寸的 PNG data URL。 */
export function alphaToInpaintMask(matte: ProductAlpha, options: InpaintMaskOptions = {}): string {
  return toPngDataUrl(encodeRgbaPng(alphaToMaskPixels(matte, options)))
}

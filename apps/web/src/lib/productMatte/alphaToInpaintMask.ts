import { dilateBinary } from './morphology'
import { encodeRgbaPngDataUrl, packRgba, WHITE } from './pngEncode'
import type { MaskPixels, ProductAlpha } from './types'

export const DEFAULT_MASK_THRESHOLD = 0.5
export const DEFAULT_MASK_FEATHER = 2
export const DEFAULT_PRODUCT_MASK_GROW = 4

/** 两次盒模糊≈三角核，比单次少一点方块感。 */
const BLUR_PASSES = 2

export interface InpaintMaskOptions {
  /** 0~1，低于此值的 alpha 归为背景。 */
  threshold?: number
  /** 羽化半径（像素），0 = 硬边。 */
  feather?: number
}

export interface ProductMaskOptions extends InpaintMaskOptions {
  /** 重绘区向外扩张的像素数；边缘与阴影接地要一起重画，不扩会留下原产品的轮廓。 */
  grow?: number
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
  const outerStep = horizontal ? width : 1
  const innerStep = horizontal ? 1 : width
  const prefix = new Float32Array(inner + 1)

  for (let o = 0; o < outer; o++) {
    const base = o * outerStep
    for (let i = 0; i < inner; i++) prefix[i + 1] = prefix[i] + src[base + i * innerStep]
    for (let i = 0; i < inner; i++) {
      const lo = Math.max(0, i - radius)
      const hi = Math.min(inner - 1, i + radius)
      out[base + i * innerStep] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1)
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

/** 阈值化 → 可选膨胀 → 可选羽化，两种遮罩共用；`invert` 决定哪一侧是重绘区。 */
function maskPixels(matte: ProductAlpha, options: ProductMaskOptions, invert: boolean): MaskPixels {
  const { width, height } = matte
  const total = width * height
  const cutoff = (options.threshold ?? DEFAULT_MASK_THRESHOLD) * 255
  const feather = Math.max(0, Math.round(options.feather ?? DEFAULT_MASK_FEATHER))
  const grow = Math.max(0, Math.round(options.grow ?? 0))

  const binary = new Float32Array(total)
  for (let i = 0; i < total; i++) binary[i] = matte.alpha[i] >= cutoff ? 255 : 0
  const grown = dilateBinary(binary, width, height, grow)
  const values = feather > 0 ? applyFeather(grown, width, height, feather) : grown

  return packRgba(values, width, height, WHITE, (value) => Math.round(invert ? 255 - value : value))
}

/**
 * 产品 alpha → 遮罩像素：产品不透明（保留），背景透明（重绘），边缘羽化。
 * RGB 恒为白，语义全在 alpha 上——原生 inpaint 只读 alpha。
 */
export function alphaToMaskPixels(
  matte: ProductAlpha,
  options: InpaintMaskOptions = {},
): MaskPixels {
  return maskPixels(matte, options, false)
}

/** 反过来的遮罩：产品透明（重绘），背景不透明（保留），重绘区向外扩一圈。 */
export function alphaToProductMaskPixels(
  matte: ProductAlpha,
  options: ProductMaskOptions = {},
): MaskPixels {
  return maskPixels(matte, { grow: DEFAULT_PRODUCT_MASK_GROW, ...options }, true)
}

/** 与 MaskEditorModal 一致的产出：与原图同尺寸的 PNG data URL。 */
export function alphaToInpaintMask(matte: ProductAlpha, options: InpaintMaskOptions = {}): string {
  return encodeRgbaPngDataUrl(alphaToMaskPixels(matte, options))
}

export function alphaToProductMask(matte: ProductAlpha, options: ProductMaskOptions = {}): string {
  return encodeRgbaPngDataUrl(alphaToProductMaskPixels(matte, options))
}

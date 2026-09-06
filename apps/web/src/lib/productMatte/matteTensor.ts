import type { MatteActivation } from './backends'

const IMAGENET_MEAN = [0.485, 0.456, 0.406]
const IMAGENET_STD = [0.229, 0.224, 0.225]

/** RGBA 方图 → NCHW float32，按 ImageNet 均值方差归一化（两个模型的上游预处理都是这套）。 */
export function rgbaToNchw(rgba: Uint8ClampedArray, size: number): Float32Array {
  const pixels = size * size
  const out = new Float32Array(3 * pixels)
  for (let i = 0; i < pixels; i++) {
    for (let channel = 0; channel < 3; channel++) {
      out[channel * pixels + i] =
        (rgba[i * 4 + channel] / 255 - IMAGENET_MEAN[channel]) / IMAGENET_STD[channel]
    }
  }
  return out
}

export function scoresToAlpha(
  scores: ArrayLike<number>,
  activation: MatteActivation,
): Uint8ClampedArray {
  const alpha = new Uint8ClampedArray(scores.length)
  if (activation === 'sigmoid') {
    for (let i = 0; i < scores.length; i++) alpha[i] = (1 / (1 + Math.exp(-scores[i]))) * 255
    return alpha
  }

  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] < min) min = scores[i]
    if (scores[i] > max) max = scores[i]
  }
  const span = max - min
  // 全平的输出没有前景可言，拉伸只会把噪声放大成一整张产品。
  if (span <= 0) return alpha
  for (let i = 0; i < scores.length; i++) alpha[i] = ((scores[i] - min) / span) * 255
  return alpha
}

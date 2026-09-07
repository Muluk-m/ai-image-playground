/** 一轴膨胀：窗口里有一个产品像素，中心就算产品。 */
function dilateAxis(
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
      out[base + i * innerStep] = prefix[hi + 1] - prefix[lo] > 0 ? 255 : 0
    }
  }
  return out
}

/** 方形核膨胀，横竖各扫一遍；`src` 是 0 / 255 的二值图。 */
export function dilateBinary(
  src: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  if (radius <= 0) return src
  return dilateAxis(dilateAxis(src, width, height, radius, true), width, height, radius, false)
}

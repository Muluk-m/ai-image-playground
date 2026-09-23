/**
 * 画布上限：输出面积超过浏览器能开的画布时，`canvas.width = n` 不会抛错，画出来的是一张空白图。
 * 所以要在建画布之前自己判，越界的那一张报错、其余照常处理。
 *
 * 数字取自引擎源码（见 `docs/research/image-toolbox.md` 3.3）：WebKit `CanvasBase.cpp` 按**面积**卡，
 * iOS 家族 8192²、其余平台 16384²；Chromium 的 `kMaxCanvasArea` 同为 268,435,456 px；
 * 两个引擎的注释都记着 Firefox 的单边上限 32767——取各家最小值就是全平台都成立的那一组。
 */
export interface CanvasLimits {
  maxArea: number
  maxSide: number
}

const FIREFOX_MAX_SIDE = 32767

export const DESKTOP_CANVAS_LIMITS: CanvasLimits = {
  maxArea: 16384 * 16384,
  maxSide: FIREFOX_MAX_SIDE,
}

/** iPhone / iPad（含「请求桌面网站」的 iPad，它报的 UA 是 Macintosh）。 */
export const IOS_CANVAS_LIMITS: CanvasLimits = {
  maxArea: 8192 * 8192,
  maxSide: FIREFOX_MAX_SIDE,
}

export interface PlatformHints {
  userAgent: string
  maxTouchPoints: number
}

export function canvasLimitsFor({ userAgent, maxTouchPoints }: PlatformHints): CanvasLimits {
  const ios =
    /iP(hone|ad|od)/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)
  return ios ? IOS_CANVAS_LIMITS : DESKTOP_CANVAS_LIMITS
}

export function exceedsCanvasLimits(width: number, height: number, limits: CanvasLimits): boolean {
  return width > limits.maxSide || height > limits.maxSide || width * height > limits.maxArea
}

/** 输出尺寸越界。宽高带在身上，卡片上要把这两个数字说给用户听。 */
export class CanvasLimitError extends Error {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    super(`output ${width}x${height} exceeds the browser canvas limit`)
    this.name = 'CanvasLimitError'
  }
}

let cached: CanvasLimits | null = null

/** 本机的上限。UA 一个会话里不会变，算一次留着。 */
export function currentCanvasLimits(): CanvasLimits {
  if (!cached)
    cached = canvasLimitsFor({
      userAgent: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints,
    })
  return cached
}

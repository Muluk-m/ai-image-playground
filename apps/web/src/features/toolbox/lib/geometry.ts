/** 单张工具的几何：旋转 / 翻转后的整幅、裁剪区、输出尺寸。纯计算，画之前先算好，越界在这一步就能判。 */

export type Rotation = 0 | 90 | 180 | 270

export interface Orientation {
  rotate: Rotation
  flipH: boolean
  flipV: boolean
}

export const UPRIGHT: Orientation = { rotate: 0, flipH: false, flipV: false }

export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

export interface Plan {
  orientation: Orientation
  /** 摆正之后那幅图上的裁剪区。 */
  crop: CropRect
  width: number
  height: number
  /** 输出比裁剪区大：平台尺寸把小图放大了。 */
  upscaled: boolean
}

export function orientedSize(width: number, height: number, rotate: Rotation) {
  return rotate === 90 || rotate === 270 ? { width: height, height: width } : { width, height }
}

/** 按比例居中裁一块尽量大的区域。`ratio` 是宽 / 高。 */
export function centerCrop(width: number, height: number, ratio: number): CropRect {
  if (width / height > ratio) {
    const w = Math.round(height * ratio)
    return { x: Math.round((width - w) / 2), y: 0, width: w, height }
  }
  const h = Math.round(width / ratio)
  return { x: 0, y: Math.round((height - h) / 2), width, height: h }
}

export type ResizeRule =
  | { mode: 'longEdge'; value: number }
  | { mode: 'width'; value: number }
  | { mode: 'percent'; value: number }

/**
 * 改尺寸后的宽高。长边只缩不放（「长边 1600」对一张 800 的图不该把它放大）；
 * 宽度与百分比照用户说的来，放大也算用户要的。
 */
export function resizedSize(width: number, height: number, rule: ResizeRule) {
  const scale =
    rule.mode === 'longEdge'
      ? Math.min(1, rule.value / Math.max(width, height))
      : rule.mode === 'width'
        ? rule.value / width
        : rule.value / 100
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export function plan(
  sourceWidth: number,
  sourceHeight: number,
  options: {
    orientation?: Orientation
    crop?: (width: number, height: number) => CropRect
    output?: (crop: CropRect) => { width: number; height: number }
  },
): Plan {
  const orientation = options.orientation ?? UPRIGHT
  const oriented = orientedSize(sourceWidth, sourceHeight, orientation.rotate)
  const crop = options.crop?.(oriented.width, oriented.height) ?? {
    x: 0,
    y: 0,
    ...oriented,
  }
  const out = options.output?.(crop) ?? { width: crop.width, height: crop.height }
  return {
    orientation,
    crop,
    width: out.width,
    height: out.height,
    upscaled: out.width > crop.width || out.height > crop.height,
  }
}

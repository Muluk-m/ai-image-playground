import type { TaskParams } from '../types'

/** 动图只有这两档帧尺寸。其它尺寸（包括自定义 816x816）不能发给上游。 */
export const GIF_FRAME_SIZES = ['512x512', '768x768'] as const

export type GifFrameSize = (typeof GIF_FRAME_SIZES)[number]

export type StillImageSettings = Pick<
  TaskParams,
  'size' | 'quality' | 'n' | 'output_compression' | 'transparent_output'
>

export function isGifFrameSize(size: string | undefined): size is GifFrameSize {
  return size === '512x512' || size === '768x768'
}

/** 已经是帧尺寸就保留，否则用 768。界面上没点过尺寸档时也按这一档提交。 */
export function gifFrameSize(size: string | undefined): GifFrameSize {
  return isGifFrameSize(size) ? size : '768x768'
}

function snapshotStill(params: TaskParams): StillImageSettings {
  return {
    size: params.size,
    quality: params.quality,
    n: params.n,
    output_compression: params.output_compression,
    transparent_output: params.transparent_output,
  }
}

/**
 * 图片 / GIF / SVG 各用各的尺寸和画质。
 * 切进 GIF 或 SVG 时记住静态图的设置，切回来原样恢复，自定义尺寸不会盖住帧尺寸。
 */
export function switchImageOutputFormat(
  params: TaskParams,
  format: TaskParams['output_format'],
  still: StillImageSettings | null,
): { patch: Partial<TaskParams>; still: StillImageSettings | null } {
  const special = params.output_format === 'gif' || params.output_format === 'svg'
  if (format === 'gif') {
    return {
      still: special ? still : snapshotStill(params),
      patch: {
        output_format: 'gif',
        quality: 'medium',
        n: 1,
        frame_count: params.frame_count ?? 6,
        frame_duration_ms: params.frame_duration_ms ?? 200,
        size: gifFrameSize(params.size),
        output_compression: null,
        transparent_output: false,
      },
    }
  }
  if (format === 'svg') {
    const remembered = special ? still : snapshotStill(params)
    return {
      still: remembered,
      patch: {
        output_format: 'svg',
        quality: 'medium',
        n: 1,
        frame_count: undefined,
        frame_duration_ms: undefined,
        size: remembered?.size ?? params.size,
        output_compression: null,
        transparent_output: false,
      },
    }
  }
  return {
    still: null,
    patch: {
      output_format: format,
      frame_count: undefined,
      frame_duration_ms: undefined,
      ...(special ? (still ?? {}) : {}),
      ...(format === 'png' ? { output_compression: null } : { transparent_output: false }),
    },
  }
}

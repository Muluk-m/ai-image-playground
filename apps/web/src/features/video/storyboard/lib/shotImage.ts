import type { VideoAspectRatio } from '@image-playground/shared'
import { calculateImageSize } from '../../../../lib/size'
import type { TaskParams } from '../../../../types'

/** 分镜图要和视频同比例，工作台左栏的尺寸只在算不出来时兜底。 */
export function storyboardImageParams(
  params: TaskParams,
  aspectRatio: VideoAspectRatio,
): TaskParams {
  return { ...params, size: calculateImageSize('1K', aspectRatio) ?? params.size, n: 1 }
}

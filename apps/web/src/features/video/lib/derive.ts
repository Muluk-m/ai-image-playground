import type { VideoDeriveMode, VideoResolution } from '@image-playground/shared'
import { i18next } from '../../../i18n'

export const VIDEO_EXTEND_SECONDS = [2, 5, 8, 10] as const
export const DEFAULT_EXTEND_SECONDS = 5

/** 派生输出的上游封顶。报价与提交必须读同一个值。 */
export const DERIVE_RESOLUTION: VideoResolution = '720p'

/** 源片时长上限。改视频的上游硬限是 8.7 秒，界面按 8 秒截断。 */
const MAX_SOURCE_SECONDS: Record<VideoDeriveMode, number> = { extend: 15, edit: 8 }
const MIN_SOURCE_SECONDS = 2

/** 源片时长是否在上游能续写 / 改写的范围内。报价与提交共用这一条硬限。 */
export function deriveSourceRefusal(mode: VideoDeriveMode, seconds: number): string | null {
  if (seconds < MIN_SOURCE_SECONDS)
    return i18next.t('derive.tooShort', { ns: 'video', seconds: MIN_SOURCE_SECONDS })
  if (seconds > MAX_SOURCE_SECONDS[mode])
    return i18next.t('derive.tooLong', { ns: 'video', seconds: MAX_SOURCE_SECONDS[mode] })
  return null
}

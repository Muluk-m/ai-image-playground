import {
  VIDEO_DERIVE_LABELS,
  VIDEO_DERIVE_MODES,
  type VideoDeriveMode,
  type VideoResolution,
} from '@image-playground/shared'
import { type VideoModelOption, videoModelOptions } from '../../../lib/channels/videoChannels'
import type { VideoTask } from '../types'

export const VIDEO_EXTEND_SECONDS = [2, 5, 8, 10] as const
export const DEFAULT_EXTEND_SECONDS = 5

/** 派生输出的上游封顶。报价与提交必须读同一个值。 */
export const DERIVE_RESOLUTION: VideoResolution = '720p'

/** 源片时长上限。改视频的上游硬限是 8.7 秒，界面按 8 秒截断。 */
const MAX_SOURCE_SECONDS: Record<VideoDeriveMode, number> = { extend: 15, edit: 8 }
const MIN_SOURCE_SECONDS = 2

export type VideoDeriveCheck =
  | { ok: true; option: VideoModelOption }
  | { ok: false; reason: string }

export interface VideoDeriveOption {
  mode: VideoDeriveMode
  /** 有 modelId 就可提交，否则 disabledReason 说明为什么不能。 */
  modelId?: string
  disabledReason?: string
}

export function checkDerive(task: VideoTask, mode: VideoDeriveMode): VideoDeriveCheck {
  const option = videoModelOptions().find((item) => item.support[mode])
  if (!option) return { ok: false, reason: `当前部署没有支持${VIDEO_DERIVE_LABELS[mode]}的模型` }
  if (task.status !== 'done' || !task.bffRequestId || task.outputIndex === undefined)
    return { ok: false, reason: '这条还没生成完' }
  if (task.duration < MIN_SOURCE_SECONDS)
    return { ok: false, reason: `源片不足 ${MIN_SOURCE_SECONDS} 秒` }
  if (task.duration > MAX_SOURCE_SECONDS[mode])
    return { ok: false, reason: `源片超过 ${MAX_SOURCE_SECONDS[mode]} 秒` }
  return { ok: true, option }
}

export function deriveOptions(task: VideoTask): VideoDeriveOption[] {
  return VIDEO_DERIVE_MODES.map((mode) => {
    const check = checkDerive(task, mode)
    return check.ok
      ? { mode, modelId: check.option.modelId }
      : { mode, disabledReason: check.reason }
  })
}

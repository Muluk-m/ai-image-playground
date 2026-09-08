import { type VideoModelOption, videoModelOptions } from '../../../lib/channels/videoChannels'
import {
  VIDEO_DERIVE_LABELS,
  VIDEO_DERIVE_MODES,
  type VideoDeriveMode,
  type VideoTask,
} from '../types'

/** 续写只挑整秒档位；上限跟着协议的 2-10 秒走。 */
export const VIDEO_EXTEND_SECONDS = [2, 5, 8, 10] as const
export const DEFAULT_EXTEND_SECONDS = 5

/** 源片时长上限。改视频的上游硬限是 8.7 秒，界面按 8 秒截断。 */
const MAX_SOURCE_SECONDS: Record<VideoDeriveMode, number> = { extend: 15, edit: 8 }
const MIN_SOURCE_SECONDS = 2

export type VideoDeriveCheck =
  | { ok: true; option: VideoModelOption }
  | { ok: false; reason: string }

export interface VideoDeriveOption {
  mode: VideoDeriveMode
  label: string
  /** 有值就是不可用，直接当按钮的 title。 */
  disabledReason?: string
}

export function deriveModelOption(mode: VideoDeriveMode): VideoModelOption | undefined {
  return videoModelOptions().find((option) => option.support[mode])
}

export function checkDerive(task: VideoTask, mode: VideoDeriveMode): VideoDeriveCheck {
  const label = VIDEO_DERIVE_LABELS[mode]
  const option = deriveModelOption(mode)
  if (!option) return { ok: false, reason: `当前部署没有支持${label}的模型` }
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
    return {
      mode,
      label: VIDEO_DERIVE_LABELS[mode],
      ...(check.ok ? {} : { disabledReason: check.reason }),
    }
  })
}

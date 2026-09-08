import {
  VIDEO_DURATIONS,
  VIDEO_MODEL_SUPPORT,
  type VideoDuration,
  type VideoModelSupport,
  videoDurationsForResolution,
} from '@image-playground/shared'
import type { VideoDraft, VideoTask } from '../types'

/** 落不到该模型的合法档位上就退到它的第一档。 */
export function clampToSupported<T>(allowed: readonly T[], value: T): T {
  return allowed.includes(value) ? value : allowed[0]!
}

/**
 * 换模型时把不支持的档位落到该模型的合法值上。帧槽不动 —— 切到不支持尾帧的模型
 * 只是不提交它，图还留着，切回去还在。
 */
export function clampDraftToSupport(draft: VideoDraft, support: VideoModelSupport): VideoDraft {
  const resolution = clampToSupported(support.resolutions, draft.resolution)
  return {
    ...draft,
    duration: clampToSupported(videoDurationsForResolution(support, resolution), draft.duration),
    aspectRatio: clampToSupported(support.aspectRatios, draft.aspectRatio),
    resolution,
  }
}

export function appendCameraMove(prompt: string, move: string): string {
  const base = prompt.trimEnd()
  if (!base) return move
  return /[，。！？；、,.!?;]$/.test(base) ? `${base}${move}` : `${base}，${move}`
}

/** 续写秒数不在该模型的档位表里，填回左栏时退到它的第一档。 */
function draftDuration(seconds: number, support: VideoModelSupport | undefined): VideoDuration {
  const durations = support?.durations ?? VIDEO_DURATIONS
  return durations.find((duration) => duration === seconds) ?? durations[0]!
}

/** 把一条任务的参数还原成左栏草稿。重生成与「相同参数再来一条」共用。 */
export function videoDraftFromTask(task: VideoTask): VideoDraft {
  const support = VIDEO_MODEL_SUPPORT[task.model]
  return {
    source: task.source,
    prompt: task.prompt,
    model: task.model,
    duration: draftDuration(task.duration, support),
    aspectRatio: task.aspectRatio,
    resolution: task.resolution,
    firstFrameImageId: task.firstFrameImageId ?? null,
    lastFrameImageId: task.lastFrameImageId ?? null,
  }
}

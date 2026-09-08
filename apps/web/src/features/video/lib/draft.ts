import {
  VIDEO_DURATIONS,
  type VideoDuration,
  type VideoModelSupport,
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
  return {
    ...draft,
    duration: clampToSupported(support.durations, draft.duration),
    aspectRatio: clampToSupported(support.aspectRatios, draft.aspectRatio),
    resolution: clampToSupported(support.resolutions, draft.resolution),
  }
}

export function appendCameraMove(prompt: string, move: string): string {
  const base = prompt.trimEnd()
  if (!base) return move
  return /[，。！？；、,.!?;]$/.test(base) ? `${base}${move}` : `${base}，${move}`
}

/** 续写秒数不在档位表里，填回左栏时退到默认档。 */
function draftDuration(seconds: number): VideoDuration {
  return VIDEO_DURATIONS.find((duration) => duration === seconds) ?? VIDEO_DURATIONS[0]
}

/** 把一条任务的参数还原成左栏草稿。重生成与「相同参数再来一条」共用。 */
export function videoDraftFromTask(task: VideoTask): VideoDraft {
  return {
    source: task.source,
    prompt: task.prompt,
    model: task.model,
    duration: draftDuration(task.duration),
    aspectRatio: task.aspectRatio,
    resolution: task.resolution,
    firstFrameImageId: task.firstFrameImageId ?? null,
    lastFrameImageId: task.lastFrameImageId ?? null,
  }
}

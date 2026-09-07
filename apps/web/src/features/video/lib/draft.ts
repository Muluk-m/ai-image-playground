import type { VideoModelSupport } from '@image-playground/shared'
import type { VideoDraft, VideoTask } from '../types'

/**
 * 换模型时把不支持的档位落到该模型的合法值上。帧槽不动 —— 切到不支持尾帧的模型
 * 只是不提交它，图还留着，切回去还在。
 */
export function clampDraftToSupport(draft: VideoDraft, support: VideoModelSupport): VideoDraft {
  return {
    ...draft,
    duration: support.durations.includes(draft.duration) ? draft.duration : support.durations[0]!,
    aspectRatio: support.aspectRatios.includes(draft.aspectRatio)
      ? draft.aspectRatio
      : support.aspectRatios[0]!,
    resolution: support.resolutions.includes(draft.resolution)
      ? draft.resolution
      : support.resolutions[0]!,
  }
}

export function appendCameraMove(prompt: string, move: string): string {
  const base = prompt.trimEnd()
  if (!base) return move
  return /[，。！？；、,.!?;]$/.test(base) ? `${base}${move}` : `${base}，${move}`
}

/** 把一条任务的参数还原成左栏草稿。重生成与「相同参数再来一条」共用。 */
export function videoDraftFromTask(task: VideoTask): VideoDraft {
  return {
    source: task.source,
    prompt: task.prompt,
    model: task.model,
    duration: task.duration,
    aspectRatio: task.aspectRatio,
    resolution: task.resolution,
    firstFrameImageId: task.firstFrameImageId ?? null,
    lastFrameImageId: task.lastFrameImageId ?? null,
  }
}

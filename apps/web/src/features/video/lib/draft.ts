import type { VideoModelSupport } from '@image-playground/shared'
import type { VideoDraft } from '../types'

/** 换模型时把不支持的档位与帧槽落到该模型的合法值上。 */
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
    firstFrameImageId: support.firstFrame ? draft.firstFrameImageId : null,
    lastFrameImageId: support.lastFrame ? draft.lastFrameImageId : null,
  }
}

export function appendCameraMove(prompt: string, move: string): string {
  const base = prompt.trimEnd()
  if (!base) return move
  return /[，。！？；、,.!?;]$/.test(base) ? `${base}${move}` : `${base}，${move}`
}

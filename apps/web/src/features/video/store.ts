import {
  VIDEO_DEFAULT_ASPECT_RATIO,
  VIDEO_DEFAULT_DURATION,
  VIDEO_DEFAULT_RESOLUTION,
  VIDEO_MODEL_SUPPORT,
  type VideoAspectRatio,
  type VideoDuration,
  type VideoResolution,
} from '@image-playground/shared'
import { create } from 'zustand'
import { videoModelOptions } from '../../lib/channels/videoChannels'
import { clampDraftToSupport } from './lib/draft'
import type { VideoDraft } from './types'

export const INITIAL_VIDEO_DRAFT: VideoDraft = {
  model: '',
  duration: VIDEO_DEFAULT_DURATION,
  aspectRatio: VIDEO_DEFAULT_ASPECT_RATIO,
  resolution: VIDEO_DEFAULT_RESOLUTION,
}

/** 画布上生成视频的参数草稿：生成栏、重新生成弹窗与智能体共读这一份。 */
export interface VideoState {
  draft: VideoDraft
  /** 把 draft.model 对齐到当前可用模型，并把档位夹回该模型的合法值。 */
  syncModelOptions(): void
  setModel(model: string): void
  setDuration(duration: VideoDuration): void
  setAspectRatio(aspectRatio: VideoAspectRatio): void
  setResolution(resolution: VideoResolution): void
}

export const useVideoStore = create<VideoState>((set, get) => ({
  draft: INITIAL_VIDEO_DRAFT,

  syncModelOptions() {
    const options = videoModelOptions()
    if (options.length === 0) return
    const draft = get().draft
    const option = options.find((item) => item.modelId === draft.model) ?? options[0]!
    set({ draft: clampDraftToSupport({ ...draft, model: option.modelId }, option.support) })
  },
  setModel(model) {
    const support = VIDEO_MODEL_SUPPORT[model]
    if (!support) return
    set((state) => ({ draft: clampDraftToSupport({ ...state.draft, model }, support) }))
  },
  setDuration(duration) {
    set((state) => ({ draft: { ...state.draft, duration } }))
  },
  setAspectRatio(aspectRatio) {
    set((state) => ({ draft: { ...state.draft, aspectRatio } }))
  },
  setResolution(resolution) {
    set((state) => {
      const support = VIDEO_MODEL_SUPPORT[state.draft.model]
      const draft = { ...state.draft, resolution }
      return { draft: support ? clampDraftToSupport(draft, support) : draft }
    })
  },
}))

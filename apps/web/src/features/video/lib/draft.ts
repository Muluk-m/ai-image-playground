import { clampVideoPreset, type VideoModelSupport } from '@image-playground/shared'
import type { VideoDraft } from '../types'

/** 换模型时把不支持的档位落到该模型的合法值上。 */
export function clampDraftToSupport(draft: VideoDraft, support: VideoModelSupport): VideoDraft {
  return { ...draft, ...clampVideoPreset(support, draft) }
}

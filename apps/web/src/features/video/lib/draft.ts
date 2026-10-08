import {
  canonicalVideoVoice,
  clampVideoPreset,
  type VideoModelSupport,
} from '@image-playground/shared'
import type { VideoDraft } from '../types'

/** 换模型时把不支持的档位落到该模型的合法值上，并丢掉这个模型不收的声音。 */
export function clampDraftToSupport(draft: VideoDraft, support: VideoModelSupport): VideoDraft {
  const voices = support.voices
    ? (draft.voices ?? [])
        .map((voice) => canonicalVideoVoice(voice))
        .filter((voice): voice is NonNullable<typeof voice> => voice !== null)
        .filter((voice, index, all) => all.indexOf(voice) === index)
        .slice(0, support.voices.max)
    : []
  return {
    ...draft,
    ...clampVideoPreset(support, draft),
    ...(voices.length ? { voices } : { voices: undefined }),
  }
}

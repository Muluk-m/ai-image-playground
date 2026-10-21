import {
  effectiveVideoNodeMode,
  narrowVideoModelSupport,
  selectStageVideoReferences,
  type VideoModelSupport,
  type VideoNodeMode,
  videoNodeModes,
} from '@image-playground/shared'
import type { NodeReference } from './nodeCanvasFlow'

export type NodeVideoMode = VideoNodeMode
export function nodeVideoModes(support: VideoModelSupport): NodeVideoMode[] {
  return videoNodeModes(support)
}
export function effectiveNodeVideoMode(
  support: VideoModelSupport,
  requested?: string,
): NodeVideoMode {
  return effectiveVideoNodeMode(support, requested)
}
/** Frame slots use connection order by default; explicit slots never silently pick another image. */
export function nodeVideoInputs(
  mode: NodeVideoMode,
  refs: readonly NodeReference[],
  slots: { first?: string; last?: string } = {},
) {
  return selectStageVideoReferences(mode, refs, slots)
}

/** Narrow the settings before rendering, so the shown quality matches this input mode. */
export function nodeVideoSupport(
  support: VideoModelSupport,
  mode: NodeVideoMode,
  hasVoices = false,
): VideoModelSupport {
  return narrowVideoModelSupport(support, mode, hasVoices)
}

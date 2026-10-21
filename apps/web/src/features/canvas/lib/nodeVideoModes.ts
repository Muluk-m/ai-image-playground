import {
  effectiveVideoNodeMode,
  narrowVideoModelSupport,
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
  const images = refs.filter((ref) => ref.kind === 'image' && !ref.asset)
  const first = slots.first !== undefined ? images.find((ref) => ref.id === slots.first) : images[0]
  const last =
    slots.last !== undefined
      ? images.find((ref) => ref.id === slots.last)
      : images.find((ref) => ref.id !== first?.id)
  const seenFiles = new Set<string>()
  const uniqueReferences = refs.filter((ref) => {
    if (ref.kind !== 'image' || (ref.asset && !ref.fileId)) return false
    const key = ref.fileId ?? ref.id
    if (seenFiles.has(key)) return false
    seenFiles.add(key)
    return true
  })
  const selected =
    mode === 'reference'
      ? uniqueReferences
      : mode === 'text'
        ? []
        : [first, ...(mode === 'frames' ? [last] : [])].filter((ref): ref is NodeReference =>
            Boolean(ref),
          )
  return {
    refs: [
      ...refs
        .filter((ref) => ref.kind === 'text' || (ref.asset && !selected.includes(ref)))
        .map((ref) => (ref.asset ? { ...ref, kind: 'text' as const, fileId: undefined } : ref)),
      ...selected,
    ],
    roles: Object.fromEntries(
      selected.map((ref) => [
        ref.id,
        mode === 'reference' ? 'reference' : ref.id === first?.id ? 'first' : 'last',
      ]),
    ),
    first: mode === 'first' || mode === 'frames' ? first : undefined,
    last: mode === 'frames' ? last : undefined,
    missing:
      ((mode === 'first' || mode === 'frames') && !first) ||
      (mode === 'frames' && (!last || last.id === first?.id)),
  }
}

/** Narrow the settings before rendering, so the shown quality matches this input mode. */
export function nodeVideoSupport(
  support: VideoModelSupport,
  mode: NodeVideoMode,
  hasVoices = false,
): VideoModelSupport {
  return narrowVideoModelSupport(support, mode, hasVoices)
}

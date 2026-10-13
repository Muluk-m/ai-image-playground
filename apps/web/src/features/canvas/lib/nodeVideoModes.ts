import { VIDEO_RESOLUTIONS, type VideoModelSupport } from '@image-playground/shared'
import type { NodeReference } from './nodeCanvasFlow'

export type NodeVideoMode = 'text' | 'first' | 'frames' | 'reference'
export function nodeVideoModes(support: VideoModelSupport): NodeVideoMode[] {
  return [
    'text',
    ...(support.firstFrame ? ['first'] : []),
    ...(support.firstFrame && support.lastFrame ? ['frames'] : []),
    ...(support.referenceImages ? ['reference'] : []),
  ] as NodeVideoMode[]
}
export function effectiveNodeVideoMode(
  support: VideoModelSupport,
  requested?: string,
): NodeVideoMode {
  const modes = nodeVideoModes(support)
  return modes.includes(requested as NodeVideoMode)
    ? (requested as NodeVideoMode)
    : support.referenceImages
      ? 'reference'
      : support.firstFrame
        ? 'first'
        : 'text'
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
    if (ref.kind !== 'image') return false
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
    refs: [...refs.filter((ref) => ref.kind === 'text'), ...selected],
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
  const caps = [
    mode === 'reference' ? support.referenceImages?.maxResolution : undefined,
    mode === 'frames' || hasVoices ? support.guideMaxResolution : undefined,
  ].filter((value): value is NonNullable<typeof value> => Boolean(value))
  const max = Math.min(...caps.map((value) => VIDEO_RESOLUTIONS.indexOf(value)))
  return caps.length
    ? {
        ...support,
        resolutions: support.resolutions.filter((value) => VIDEO_RESOLUTIONS.indexOf(value) <= max),
      }
    : support
}

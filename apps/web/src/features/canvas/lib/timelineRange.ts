/** Pure playback bounds shared by the canvas, editor and export plan. Stored edit intent stays intact. */
export const TIMELINE_UNKNOWN_SECONDS = 5
export function timelineClipRange(clip: { in: number; out?: number }, source: number | undefined) {
  const end = Math.max(0, source ?? clip.out ?? TIMELINE_UNKNOWN_SECONDS)
  const out = Math.max(0, Math.min(clip.out ?? end, end))
  return { in: Math.max(0, Math.min(clip.in, Math.max(0, out - 0.1))), out }
}

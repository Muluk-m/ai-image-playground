import type { TimelineClip } from './canvasDoc'
import { TIMELINE_UNKNOWN_SECONDS } from './timeline'

/** 一段最短播多久。再短就只剩一两帧，预览里一闪而过、导出也没有意义。 */
export const MIN_CLIP_SECONDS = 0.5

/** 按源片 id 查源片时长（秒）；不知道时返回 undefined。 */
export type SourceSeconds = (elementId: string) => number | undefined

function round(seconds: number): number {
  return Math.round(seconds * 100) / 100
}

/** 这一段实际从源片的哪一秒播到哪一秒。出点缺省播到结尾；源时长未知按占位时长。 */
export function clipRange(clip: TimelineClip, source: number | undefined) {
  const end = source ?? clip.out ?? TIMELINE_UNKNOWN_SECONDS
  return { in: clip.in, out: Math.min(clip.out ?? end, end) }
}

export function moveClip(clips: readonly TimelineClip[], from: number, to: number) {
  if (from === to || !clips[from]) return [...clips]
  const next = [...clips]
  const [moved] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved!)
  return next
}

export function removeClip(clips: readonly TimelineClip[], index: number) {
  return clips.filter((_, at) => at !== index)
}

/** 拖一侧边缘改入点或出点：不出源片范围，入出点之间至少留 MIN_CLIP_SECONDS。 */
export function trimClip(
  clip: TimelineClip,
  edge: 'in' | 'out',
  seconds: number,
  source: number | undefined,
): TimelineClip {
  const range = clipRange(clip, source)
  const end = source ?? range.out
  if (edge === 'in') {
    const value = Math.min(Math.max(0, seconds), range.out - MIN_CLIP_SECONDS)
    return { ...clip, in: round(Math.max(0, value)), out: round(range.out) }
  }
  const value = Math.max(Math.min(end, seconds), range.in + MIN_CLIP_SECONDS)
  return { ...clip, out: round(Math.min(end, value)) }
}

export function clipDuration(clip: TimelineClip, source: number | undefined): number {
  const range = clipRange(clip, source)
  return Math.max(0, range.out - range.in)
}

export function totalDuration(clips: readonly TimelineClip[], sourceOf: SourceSeconds): number {
  return round(clips.reduce((sum, clip) => sum + clipDuration(clip, sourceOf(clip.elementId)), 0))
}

export function startOfClip(
  clips: readonly TimelineClip[],
  sourceOf: SourceSeconds,
  index: number,
): number {
  return round(
    clips
      .slice(0, index)
      .reduce((sum, clip) => sum + clipDuration(clip, sourceOf(clip.elementId)), 0),
  )
}

/** 全局播放头落在哪一段、对应源片的哪一秒。超出末尾就停在最后一段的出点。 */
export function locateTime(
  clips: readonly TimelineClip[],
  sourceOf: SourceSeconds,
  time: number,
): { index: number; sourceTime: number } {
  let start = 0
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index]!
    const duration = clipDuration(clip, sourceOf(clip.elementId))
    if (time < start + duration || index === clips.length - 1) {
      const range = clipRange(clip, sourceOf(clip.elementId))
      const offset = Math.min(Math.max(0, time - start), duration)
      return { index, sourceTime: round(range.in + offset) }
    }
    start += duration
  }
  return { index: 0, sourceTime: 0 }
}

import type { CanvasEl, TimelineClip, TimelineEl } from './canvasDoc'
import { newElementId } from './canvasDoc'
import type { CanvasEditor } from './editor'
import { Box } from './geometry'
import { PLACEMENT_GAP } from './placement'

/** 画布上一秒占多宽（页面单位）。8 秒一段约 200，和默认的 360 宽图片放在一起不突兀。 */
export const TIMELINE_PX_PER_SECOND = 24
export const TIMELINE_HEIGHT = 120
export const TIMELINE_PADDING = 12
/** 时长未知（旧视频没有生成记录）时按这么长画，入出点编辑时再按实际时长修正。 */
export const TIMELINE_UNKNOWN_SECONDS = 5
/** 片段太短时也保留能点中的宽度。 */
const MIN_SEGMENT_WIDTH = 32

export interface TimelineSegment {
  index: number
  elementId: string
  x: number
  width: number
  seconds: number
  /** 源视频已经不在画布上。 */
  missing: boolean
}

type ElementLookup = (id: string) => CanvasEl | undefined

/** 源视频的时长：生成记录里有就用，没有按未知处理。 */
export function sourceSeconds(element: CanvasEl | undefined): number | undefined {
  return element?.type === 'image' ? element.video?.generation?.duration : undefined
}

/** 一段实际播多长。出点缺省播到结尾；源时长未知时按占位时长。 */
export function clipSeconds(clip: TimelineClip, element: CanvasEl | undefined): number {
  const end = clip.out ?? sourceSeconds(element) ?? TIMELINE_UNKNOWN_SECONDS
  return Math.max(0, end - clip.in)
}

export function isTimelineSource(element: CanvasEl | undefined): boolean {
  return element?.type === 'image' && Boolean(element.video)
}

/** 片段在时间线内部的排布（相对时间线左上角）。 */
export function timelineSegments(clips: readonly TimelineClip[], lookup: ElementLookup) {
  let x = TIMELINE_PADDING
  return clips.map((clip, index): TimelineSegment => {
    const element = lookup(clip.elementId)
    const seconds = clipSeconds(clip, element)
    const width = Math.max(MIN_SEGMENT_WIDTH, seconds * TIMELINE_PX_PER_SECOND)
    const segment = {
      index,
      elementId: clip.elementId,
      x,
      width,
      seconds,
      missing: !isTimelineSource(element),
    }
    x += width + 4
    return segment
  })
}

export function timelineWidth(clips: readonly TimelineClip[], lookup: ElementLookup): number {
  const segments = timelineSegments(clips, lookup)
  const last = segments[segments.length - 1]
  return Math.max(240, last ? last.x + last.width + TIMELINE_PADDING : 240)
}

export function timelineSeconds(clips: readonly TimelineClip[], lookup: ElementLookup): number {
  return clips.reduce((sum, clip) => sum + clipSeconds(clip, lookup(clip.elementId)), 0)
}

/**
 * 「加入时间线」：选中的视频按画布上从左到右追加。选区里本来就有一条时间线就追加到它后面，
 * 否则在这些视频下方新建一条。返回时间线 id；选区里没有视频返回 null。
 */
export function addSelectionToTimeline(editor: CanvasEditor): string | null {
  const selected = editor.getSelectedIds().map((id) => editor.getElement(id))
  const videos = selected
    .filter((el): el is Extract<CanvasEl, { type: 'image' }> => isTimelineSource(el))
    .sort((a, b) => a.x - b.x)
  if (videos.length === 0) return null
  const lookup: ElementLookup = (id) => editor.getElement(id)
  const clips = videos.map((video): TimelineClip => ({ elementId: video.id, in: 0 }))
  const existing = selected.find((el): el is TimelineEl => el?.type === 'timeline')
  if (existing) {
    const next = [...existing.clips, ...clips]
    editor.doc.updateElements([
      { id: existing.id, patch: { clips: next, width: timelineWidth(next, lookup) } },
    ])
    editor.setSelectedElements([existing.id])
    return existing.id
  }
  const bounds = Box.Common(
    videos.map((video) => editor.getElementPageBounds(video.id)).filter((box) => box !== undefined),
  )
  const timeline: TimelineEl = {
    id: newElementId(),
    type: 'timeline',
    x: bounds.x,
    y: bounds.maxY + PLACEMENT_GAP,
    width: timelineWidth(clips, lookup),
    height: TIMELINE_HEIGHT,
    clips,
  }
  editor.doc.addElements([timeline])
  editor.setSelectedElements([timeline.id])
  return timeline.id
}

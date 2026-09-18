import { type AgentTimelinePlan, PROJECT_TIMELINE_MAX_CLIPS } from '@image-playground/shared'
import { i18next } from '../../../i18n'
import { useStore } from '../../../store'
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
 * 「加入时间线」：选中的视频按画布上从左到右追加。追加到哪一条：选区里带着一条就是它；
 * 选区里没有、画布上正好只有一条，也追加到它；否则在这些视频下方新建一条。
 * 返回时间线 id；选区里没有视频返回 null。
 */
export function addSelectionToTimeline(editor: CanvasEditor): string | null {
  const selected = editor.getSelectedIds().map((id) => editor.getElement(id))
  const videos = selected
    .filter((el): el is Extract<CanvasEl, { type: 'image' }> => isTimelineSource(el))
    .sort((a, b) => a.x - b.x)
  if (videos.length === 0) return null
  const lookup: ElementLookup = (id) => editor.getElement(id)
  // 能知道时长就把出点定下来：源视频之后被删，这一段的长度和成片总长都不跟着变。
  const clips = videos.map((video): TimelineClip => {
    const seconds = sourceSeconds(video)
    return seconds === undefined
      ? { elementId: video.id, in: 0 }
      : { elementId: video.id, in: 0, out: seconds }
  })
  const onCanvas = editor.getElements().filter((el): el is TimelineEl => el.type === 'timeline')
  const existing =
    selected.find((el): el is TimelineEl => el?.type === 'timeline') ??
    (onCanvas.length === 1 ? onCanvas[0] : undefined)
  const room = PROJECT_TIMELINE_MAX_CLIPS - (existing?.clips.length ?? 0)
  // 超出上限的片段云端项目收不下，整份项目会同步失败；宁可少加并说明。
  if (clips.length > room)
    useStore
      .getState()
      .showToast(
        i18next.t('timeline.full', { ns: 'canvas', max: PROJECT_TIMELINE_MAX_CLIPS }),
        'error',
      )
  const accepted = clips.slice(0, Math.max(0, room))
  if (existing) {
    if (accepted.length === 0) return existing.id
    const next = [...existing.clips, ...accepted]
    editor.doc.updateElements(
      [{ id: existing.id, patch: { clips: next, width: timelineWidth(next, lookup) } }],
      { history: true },
    )
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
    width: timelineWidth(accepted, lookup),
    height: TIMELINE_HEIGHT,
    clips: accepted,
  }
  editor.doc.addElements([timeline])
  editor.setSelectedElements([timeline.id])
  return timeline.id
}

/**
 * 智能体排的时间线落画布：只收画布上还在的视频，按智能体给的顺序与入出点排，
 * 放在这些视频下方。时间线 id 用智能体给的那个，同一次排布重放不会建出第二条，
 * 也不动用户已有的时间线。一段都收不下时不建，返回 null。
 */
export function placeTimelinePlan(editor: CanvasEditor, plan: AgentTimelinePlan): string | null {
  if (editor.getElement(plan.timelineId)) return plan.timelineId
  const clips = plan.clips
    .filter((clip) => isTimelineSource(editor.getElement(clip.videoId)))
    .slice(0, PROJECT_TIMELINE_MAX_CLIPS)
    .map(
      (clip): TimelineClip =>
        clip.out !== undefined && clip.out > clip.in
          ? { elementId: clip.videoId, in: clip.in, out: clip.out }
          : { elementId: clip.videoId, in: clip.in },
    )
  if (clips.length === 0) return null
  const lookup: ElementLookup = (id) => editor.getElement(id)
  const bounds = Box.Common(
    [...new Set(clips.map((clip) => clip.elementId))]
      .map((id) => editor.getElementPageBounds(id))
      .filter((box) => box !== undefined),
  )
  editor.doc.addElements([
    {
      id: plan.timelineId,
      type: 'timeline',
      x: bounds.x,
      y: bounds.maxY + PLACEMENT_GAP,
      width: timelineWidth(clips, lookup),
      height: TIMELINE_HEIGHT,
      clips,
    },
  ])
  return plan.timelineId
}

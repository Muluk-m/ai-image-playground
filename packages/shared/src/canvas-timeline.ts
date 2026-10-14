import * as Y from 'yjs'
import type { ProjectTimeline } from './project-protocol'

type Clip = ProjectTimeline['clips'][number]
export type CanvasTimelineDraftClip = Clip & { slotKey?: string }
export interface CanvasTimelineSlot {
  target: string
  clip: Clip
  order: number
  deleted?: boolean
}

export function timelineSlotsOf(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap('timelineSlots')
}
const fieldKey = (key: string, field: string) => JSON.stringify([...JSON.parse(key), field])

/** Imported arrays are immutable bases. Each slot's trim, order and deletion merge independently. */
export function canvasTimelineSlots(doc: Y.Doc, target: string, base: Clip[]) {
  const slots = new Map<string, CanvasTimelineSlot>(
    base.map((clip, order) => [JSON.stringify([target, 'legacy', order]), { target, clip, order }]),
  )
  for (const [key, value] of timelineSlotsOf(doc)) {
    const [owner, kind, id, field] = JSON.parse(key)
    if (owner !== target) continue
    const slotKey = JSON.stringify([owner, kind, id])
    const slot = slots.get(slotKey) ?? {
      target,
      clip: { elementId: String(id), in: 0 },
      order: base.length,
    }
    if (field === 'clip') slot.clip = value as Clip
    else if (field === 'order') slot.order = value as number
    else if (field === 'deleted') slot.deleted = value as boolean
    slots.set(slotKey, slot)
  }
  return [...slots]
    .filter(([, slot]) => !slot.deleted)
    .sort(([a, x], [b, y]) => x.order - y.order || a.localeCompare(b))
}

export function appendCanvasTimelineClip(doc: Y.Doc, target: string, clip: Clip, order: number) {
  const key = JSON.stringify([target, 'source', clip.elementId]),
    slots = timelineSlotsOf(doc)
  slots.set(fieldKey(key, 'clip'), clip)
  slots.set(fieldKey(key, 'order'), order)
  slots.set(fieldKey(key, 'deleted'), false)
}

/** Only patch fields changed relative to the opened draft; unseen remote slots remain untouched. */
export function editCanvasTimelineClips(
  doc: Y.Doc,
  target: string,
  baseline: [string, CanvasTimelineSlot][],
  clips: CanvasTimelineDraftClip[],
) {
  const remaining = [...baseline],
    slots = timelineSlotsOf(doc)
  const resolved: { key: string; clip: Clip; old?: [string, CanvasTimelineSlot] }[] = []
  clips.forEach((draft) => {
    const { slotKey, ...clip } = draft
    const index = remaining.findIndex(([key, slot]) =>
      slotKey ? key === slotKey : slot.clip.elementId === clip.elementId,
    )
    const old = index < 0 ? undefined : remaining.splice(index, 1)[0]
    const key = old?.[0] ?? JSON.stringify([target, 'source', clip.elementId])
    resolved.push({ key, clip, old })
  })
  const reordered =
    resolved.length !== baseline.length ||
    resolved.some(({ key }, index) => key !== baseline[index]?.[0])
  resolved.forEach(({ key, clip, old }, order) => {
    if (!old || JSON.stringify(old[1].clip) !== JSON.stringify(clip))
      slots.set(fieldKey(key, 'clip'), clip)
    if (reordered) slots.set(fieldKey(key, 'order'), order)
    if (!old) slots.set(fieldKey(key, 'deleted'), false)
  })
  for (const [key] of remaining) slots.set(fieldKey(key, 'deleted'), true)
}

export function deleteCanvasTimelineSlots(doc: Y.Doc, target: string) {
  for (const key of timelineSlotsOf(doc).keys())
    if (JSON.parse(key)[0] === target) timelineSlotsOf(doc).delete(key)
}

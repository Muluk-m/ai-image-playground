import * as Y from 'yjs'
import type { CanvasOrigin } from './canvas-document'
import { canvasFingerprint } from './canvas-fingerprint'
import {
  isProductionShots,
  PRODUCTION_SHOTS_MAX,
  type ProductionShot,
} from './production-storyboard'

export interface CanvasStoryboardData {
  shots: ProductionShot[]
  /** Episode number is project-wide; scriptNodeId records its source, not a separate namespace. */
  episode?: { scriptNodeId: string; number: number }
  /** Confirmation applies to this exact shot table; edits invalidate it without deleting the receipt. */
  confirmed?: { fingerprint: string; model: string; quantity: number; credits?: number }
}

export function isCanvasStoryboardData(value: unknown): value is CanvasStoryboardData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const data = value as Record<string, unknown>
  if (
    Object.keys(data).some((key) => !['shots', 'confirmed', 'episode'].includes(key)) ||
    !Array.isArray(data.shots) ||
    data.shots.length > 1000 ||
    !data.shots.every((shot) => isProductionShots([shot])) ||
    new Set(data.shots.map((shot) => shot.id)).size !== data.shots.length
  )
    return false
  if (
    data.shots.some((shot) =>
      Object.keys(shot).some(
        (key) =>
          ![
            'id',
            'description',
            'dialogue',
            'camera',
            'durationSeconds',
            'lookIds',
            'locationId',
          ].includes(key),
      ),
    )
  )
    return false
  if (data.episode !== undefined) {
    const episode = data.episode
    if (
      !episode ||
      typeof episode !== 'object' ||
      Array.isArray(episode) ||
      Object.keys(episode).some((key) => !['scriptNodeId', 'number'].includes(key)) ||
      !('scriptNodeId' in episode) ||
      typeof episode.scriptNodeId !== 'string' ||
      !episode.scriptNodeId.trim() ||
      episode.scriptNodeId.length > 128 ||
      !('number' in episode) ||
      !Number.isSafeInteger(episode.number) ||
      Number(episode.number) < 1 ||
      Number(episode.number) > 200
    )
      return false
  }
  const confirmed = data.confirmed
  return (
    confirmed === undefined ||
    (typeof confirmed === 'object' &&
      confirmed !== null &&
      !Array.isArray(confirmed) &&
      Object.keys(confirmed).every((key) =>
        ['fingerprint', 'model', 'quantity', 'credits'].includes(key),
      ) &&
      'fingerprint' in confirmed &&
      typeof confirmed.fingerprint === 'string' &&
      /^v1:[0-9]+:[a-f0-9]+:[a-f0-9]+$/.test(confirmed.fingerprint) &&
      'model' in confirmed &&
      typeof confirmed.model === 'string' &&
      confirmed.model.length <= 256 &&
      'quantity' in confirmed &&
      Number.isSafeInteger(confirmed.quantity) &&
      Number(confirmed.quantity) >= 0 &&
      Number(confirmed.quantity) <= PRODUCTION_SHOTS_MAX &&
      (!('credits' in confirmed) ||
        (typeof confirmed.credits === 'number' &&
          Number.isFinite(confirmed.credits) &&
          confirmed.credits >= 0)))
  )
}

export function storyboardFingerprint(shots: readonly ProductionShot[]): string {
  return canvasFingerprint(
    JSON.stringify(
      shots.map((s) => [
        s.id,
        s.description,
        s.dialogue ?? '',
        s.camera ?? '',
        s.durationSeconds ?? null,
        s.lookIds,
        s.locationId ?? null,
      ]),
    ),
  )
}

export function initializeStoryboard(node: Y.Map<unknown>, shots: readonly ProductionShot[]): void {
  if (node.has('storyboardShots')) return
  const entries = new Y.Map<Y.Map<unknown>>()
  shots.forEach((shot, order) => {
    const entry = new Y.Map<unknown>()
    for (const [key, value] of Object.entries({ ...shot, order })) entry.set(key, value)
    entries.set(shot.id, entry)
  })
  node.set('storyboardShots', entries)
}

export function readStoryboard(node: Y.Map<unknown>): ProductionShot[] {
  const entries = node.get('storyboardShots')
  if (!(entries instanceof Y.Map)) return (node.get('data') as CanvasStoryboardData).shots
  return [...entries.values()]
    .map((entry) => entry.toJSON() as ProductionShot & { order: number; deleted?: boolean })
    .filter((shot) => !shot.deleted)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map(({ order: _order, deleted: _deleted, ...shot }) => shot)
}

function entriesOf(doc: Y.Doc, nodeId: string) {
  const node = doc.getMap<Y.Map<unknown>>('nodes').get(nodeId)
  if (node?.get('type') !== 'storyboard') return
  return node.get('storyboardShots') as Y.Map<Y.Map<unknown>>
}

export function addStoryboardShot(
  doc: Y.Doc,
  nodeId: string,
  shot: ProductionShot,
  origin: CanvasOrigin,
): boolean {
  const entries = entriesOf(doc, nodeId)
  if (
    !entries ||
    entries.has(shot.id) ||
    !isCanvasStoryboardData({ shots: [shot] }) ||
    entries.size >= 1000 ||
    [...entries.values()].filter((entry) => !entry.get('deleted')).length >= PRODUCTION_SHOTS_MAX
  )
    return false
  doc.transact(() => {
    const entry = new Y.Map<unknown>()
    for (const [key, value] of Object.entries({ ...shot, order: entries.size }))
      entry.set(key, value)
    entries.set(shot.id, entry)
  }, origin)
  return true
}

export function updateStoryboardShot(
  doc: Y.Doc,
  nodeId: string,
  shotId: string,
  patch: Partial<Omit<ProductionShot, 'id'>>,
  origin: CanvasOrigin,
): void {
  const entry = entriesOf(doc, nodeId)?.get(shotId)
  if (!entry || entry.get('deleted')) return
  const { order: _order, ...current } = entry.toJSON()
  if (!isCanvasStoryboardData({ shots: [{ ...current, ...patch }] })) return
  doc.transact(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (JSON.stringify(entry.get(key)) === JSON.stringify(value)) continue
      if (value === undefined) entry.delete(key)
      else entry.set(key, value)
    }
  }, origin)
}

export function deleteStoryboardShot(
  doc: Y.Doc,
  nodeId: string,
  shotId: string,
  origin: CanvasOrigin,
): void {
  const entry = entriesOf(doc, nodeId)?.get(shotId)
  if (entry) doc.transact(() => entry.set('deleted', true), origin)
}

export function reorderStoryboardShots(
  doc: Y.Doc,
  nodeId: string,
  ids: readonly string[],
  origin: CanvasOrigin,
): void {
  const entries = entriesOf(doc, nodeId)
  if (!entries) return
  doc.transact(
    () =>
      ids.forEach((id, order) => {
        const entry = entries.get(id)
        if (entry && !entry.get('deleted') && entry.get('order') !== order)
          entry.set('order', order)
      }),
    origin,
  )
}

/** Generic import/Agent updates preserve existing Y.Map rows and change individual fields. */
export function replaceStoryboardShots(
  doc: Y.Doc,
  nodeId: string,
  shots: readonly ProductionShot[],
  origin: CanvasOrigin,
): void {
  const current = entriesOf(doc, nodeId)
  if (!current || !isCanvasStoryboardData({ shots })) return
  const wanted = new Set(shots.map((shot) => shot.id))
  doc.transact(() => {
    for (const id of current.keys())
      if (!wanted.has(id)) deleteStoryboardShot(doc, nodeId, id, origin)
    for (const shot of shots) {
      if (!current.has(shot.id)) {
        addStoryboardShot(doc, nodeId, shot, origin)
        continue
      }
      const { id: _id, ...patch } = shot
      updateStoryboardShot(
        doc,
        nodeId,
        shot.id,
        {
          dialogue: undefined,
          camera: undefined,
          durationSeconds: undefined,
          locationId: undefined,
          ...patch,
        },
        origin,
      )
    }
    reorderStoryboardShots(
      doc,
      nodeId,
      shots.map((shot) => shot.id),
      origin,
    )
  }, origin)
}

import * as Y from 'yjs'

type Lineage = [
  client: number,
  clock: number,
  length: number,
  targetClient: number,
  targetClock: number,
]
const limit = 20_000
const origin = Object.freeze({ kind: 'undo-lineage' })

function valid(value: unknown): value is Lineage {
  return (
    Array.isArray(value) &&
    value.length === 5 &&
    value.every((n) => Number.isSafeInteger(n) && n >= 0) &&
    value[2] > 0
  )
}

export function validateCanvasUndoLineage(doc: Y.Doc): void {
  const lineage = doc.getMap('undoLineage')
  if (lineage.size > limit) throw new Error('canvas_undo_history_too_large')
  for (const [key, value] of lineage) {
    if (!valid(value) || key !== `${value[0]}:${value[1]}`)
      throw new Error('invalid_canvas_undo_lineage')
  }
}

/** Yjs update encoding omits Item.redone. Share these pointers for mixed local/Agent history. */
export function publishCanvasUndoLineage(doc: Y.Doc): void {
  const lineage = doc.getMap<Lineage>('undoLineage')
  doc.transact(() => {
    for (const structs of doc.store.clients.values())
      for (const item of structs) {
        if (!(item instanceof Y.Item) || !item.redone) continue
        const key = `${item.id.client}:${item.id.clock}`
        const value: Lineage = [
          item.id.client,
          item.id.clock,
          item.length,
          item.redone.client,
          item.redone.clock,
        ]
        const before = lineage.get(key)
        if (!before || value.some((n, i) => n !== before[i])) lineage.set(key, value)
      }
  }, origin)
}

/** Restore only bounded, existing, compatible pointers; never follow cyclic client metadata. */
export function restoreCanvasUndoLineage(doc: Y.Doc): void {
  validateCanvasUndoLineage(doc)
  doc.transact((transaction) => {
    const ranges: Array<{ source: Y.ID; target: Y.ID; length: number }> = []
    for (const value of doc.getMap<Lineage>('undoLineage').values()) {
      const [client, clock, length, targetClient, targetClock] = value
      if (
        Y.getState(doc.store, client) < clock + length ||
        Y.getState(doc.store, targetClient) < targetClock + length
      )
        continue
      // The sender may have merged a string that the receiving UndoManager still
      // keeps split (for example, body text and Quill's terminal newline). Restore
      // every segment, not only the first Item in the serialized range. ContentDeleted
      // neighbors retain identity/position after GC and must also follow their restored copy.
      for (let offset = 0; offset < length; ) {
        const sourceId = Y.createID(client, clock + offset)
        const targetId = Y.createID(targetClient, targetClock + offset)
        const source = Y.getItemCleanStart(transaction, sourceId)
        const target = Y.getItemCleanStart(transaction, targetId)
        const size = Math.min(
          length - offset,
          source.id.clock + source.length - sourceId.clock,
          target.id.clock + target.length - targetId.clock,
        )
        Y.getItemCleanEnd(transaction, doc.store, Y.createID(client, clock + offset + size - 1))
        if (
          source instanceof Y.Item &&
          target instanceof Y.Item &&
          source.deleted &&
          (source.content.constructor === target.content.constructor ||
            source.content instanceof Y.ContentDeleted ||
            target.content instanceof Y.ContentDeleted)
        )
          ranges.push({ source: sourceId, target: targetId, length: size })
        offset += size
      }
    }
    // A later range can split an Item seen earlier (when that Item is also a
    // target). Resolve ranges to final segments only after all splitting is done.
    const candidates = new Map<Y.Item, Y.ID>()
    for (const range of ranges) {
      for (let offset = 0; offset < range.length; ) {
        const item = Y.getItem(
          doc.store,
          Y.createID(range.source.client, range.source.clock + offset),
        )
        if (item instanceof Y.Item)
          candidates.set(item, Y.createID(range.target.client, range.target.clock + offset))
        offset += Math.min(range.length - offset, item.length)
      }
    }
    // Check the complete pointer graph before installing any of it. Iterative traversal avoids
    // stack overflow even when a synced document contains a long or malicious pointer chain.
    const safe = new Set<Y.Item>()
    for (const item of candidates.keys()) {
      const path = new Set<Y.Item>()
      let next: Y.Item | undefined = item
      while (next && !safe.has(next)) {
        if (path.has(next)) throw new Error('invalid_canvas_undo_lineage')
        path.add(next)
        const id: Y.ID | null | undefined = candidates.get(next) ?? next.redone
        const target: Y.Item | Y.GC | null = id ? Y.getItem(doc.store, id) : null
        next = target instanceof Y.Item ? target : undefined
      }
      for (const entry of path) safe.add(entry)
    }
    for (const [item, target] of candidates) item.redone = target
  }, origin)
}

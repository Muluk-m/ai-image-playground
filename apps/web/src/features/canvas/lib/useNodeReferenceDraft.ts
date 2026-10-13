import { useSyncExternalStore } from 'react'
import { fileToDataUrl } from './importImages'

interface ReferenceDraft {
  items: { id: string; name: string; url: string }[]
  uploading: boolean
}
function createDraft() {
  let snapshot: ReferenceDraft = { items: [], uploading: false }
  const listeners = new Set<() => void>()
  const update = (patch: Partial<ReferenceDraft>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    remove: (id: string) => update({ items: snapshot.items.filter((item) => item.id !== id) }),
    async upload(file: File) {
      if (snapshot.uploading) return
      update({ uploading: true })
      try {
        const url = await fileToDataUrl(file)
        const item = { id: crypto.randomUUID(), name: file.name, url }
        update({ items: [...snapshot.items, item] })
        return item
      } finally {
        update({ uploading: false })
      }
    },
  }
}
// Ephemeral to this open document, but preserved when selection unmounts a node composer.
const drafts = new WeakMap<object, Map<string, ReturnType<typeof createDraft>>>()
export function useNodeReferenceDraft(document: object, nodeId: string) {
  let nodes = drafts.get(document)
  if (!nodes) {
    nodes = new Map()
    drafts.set(document, nodes)
  }
  let draft = nodes.get(nodeId)
  if (!draft) {
    draft = createDraft()
    nodes.set(nodeId, draft)
  }
  const snapshot = useSyncExternalStore(draft.subscribe, draft.getSnapshot)
  return { ...snapshot, upload: draft.upload, remove: draft.remove }
}

export function nodeReferenceDraft(document: object, nodeId: string): ReferenceDraft {
  return drafts.get(document)?.get(nodeId)?.getSnapshot() ?? { items: [], uploading: false }
}

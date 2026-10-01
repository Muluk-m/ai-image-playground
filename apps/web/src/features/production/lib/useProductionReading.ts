import { useState } from 'react'
import { safeLocalStorage, scopedStorageName } from '../../../lib/authScope'

export type ProductionTab = 'setting' | 'outline' | 'scenes'
interface ReadingPosition {
  tab: ProductionTab
  closedScenes: readonly string[]
  scroll: Record<ProductionTab, number>
}
const empty = (): ReadingPosition => ({
  tab: 'scenes',
  closedScenes: [],
  scroll: { setting: 0, outline: 0, scenes: 0 },
})
function read(key: string): ReadingPosition {
  try {
    const value = JSON.parse(safeLocalStorage.getItem(key) ?? 'null')
    if (
      !value ||
      !['setting', 'outline', 'scenes'].includes(value.tab) ||
      !Array.isArray(value.closedScenes) ||
      !value.closedScenes.every((id: unknown) => typeof id === 'string') ||
      !value.scroll ||
      !['setting', 'outline', 'scenes'].every(
        (tab) => Number.isFinite(value.scroll[tab]) && value.scroll[tab] >= 0,
      )
    )
      return empty()
    return value
  } catch {
    return empty()
  }
}

/** Reading preferences share the document identity, but never carry editable content. */
export function useProductionReading(conversationId: string, documentId: string) {
  const key = scopedStorageName(`production-reading:${conversationId}:${documentId}`)
  const [position, setPosition] = useState(() => read(key))
  const update = (change: (current: ReadingPosition) => ReadingPosition) =>
    setPosition((current) => {
      const next = change(current)
      safeLocalStorage.setItem(key, JSON.stringify(next))
      return next
    })
  return { position, update }
}

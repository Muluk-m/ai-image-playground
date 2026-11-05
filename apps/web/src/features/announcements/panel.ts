import type { AnnouncementPublicItem, AnnouncementPublicList } from '@image-playground/shared'

type Listener = () => void

const EMPTY_ITEMS: AnnouncementPublicItem[] = []

let items: AnnouncementPublicItem[] = EMPTY_ITEMS
let unread = 0
let status: AnnouncementFeedStatus = 'loading'
const listeners = new Set<Listener>()

export type AnnouncementFeedStatus = 'loading' | 'ready' | 'error'

function emit(): void {
  for (const listener of listeners) listener()
}

export function announcementItems(): AnnouncementPublicItem[] {
  return items
}

export function announcementUnreadCount(): number {
  return unread
}

export function announcementFeedStatus(): AnnouncementFeedStatus {
  return status
}

export function setAnnouncementFeed(list: AnnouncementPublicList): void {
  items = list.items
  unread = list.unreadCount
  status = 'ready'
  emit()
}

/** 第一次就失败才换成错误态；已经有内容时保留上一份。 */
export function setAnnouncementFeedError(): void {
  if (items.length === 0) status = 'error'
  emit()
}

export function applyAnnouncementRead(ids: readonly string[], dismissed: boolean): void {
  if (!ids.length) return
  const idSet = new Set(ids)
  let changed = false
  const next = items.map((item) => {
    if (!idSet.has(item.id) || (!item.unread && (!dismissed || item.dismissed))) return item
    changed = true
    return { ...item, unread: false, dismissed: item.dismissed || dismissed }
  })
  if (!changed) return
  items = next
  unread = next.filter((item) => item.unread).length
  emit()
}

export function subscribeAnnouncementPanel(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

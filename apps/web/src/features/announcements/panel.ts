type Listener = () => void

let open = false
let unread = 0
const listeners = new Set<Listener>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function announcementPanelOpen(): boolean {
  return open
}

export function announcementUnreadCount(): number {
  return unread
}

export function setAnnouncementPanelOpen(next: boolean): void {
  if (open === next) return
  open = next
  emit()
}

export function setAnnouncementUnreadCount(next: number): void {
  if (unread === next) return
  unread = next
  emit()
}

export function subscribeAnnouncementPanel(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

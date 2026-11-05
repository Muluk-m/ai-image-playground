import type { AnnouncementPublicItem, AnnouncementPublicList } from '@image-playground/shared'

type Listener = () => void

const EMPTY_ITEMS: AnnouncementPublicItem[] = []

let items: AnnouncementPublicItem[] = EMPTY_ITEMS
let unread = 0
let status: AnnouncementFeedStatus = 'loading'
// 一代 = 一个账号的订阅。换账号换代，上一代还在路上的请求回来时全部作废。
let generation = 0
let feedAccount: string | null = null
// 每次拉取一个序号。同一账号下 Host 和更新页（以及换语言）会各发请求，
// 回来晚的旧请求不能盖掉已经写进来的新结果。
let loadSeq = 0
let appliedSeq = 0
// 本代里已经标过的条目。拉取在标已读之前发出、之后才回来时，用它把已读盖回去。
const localReads = new Map<string, boolean>()
const listeners = new Set<Listener>()

export type AnnouncementFeedStatus = 'loading' | 'ready' | 'error'

/** 一次拉取：属于哪个账号代，以及它是第几次发出的。 */
export interface AnnouncementLoad {
  generation: number
  seq: number
}

function newLoad(): AnnouncementLoad {
  return { generation, seq: ++loadSeq }
}

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

/**
 * 开始为某个账号拉取。账号变了就清掉上一个账号的列表并换代，
 * 旧列表不会再被当成新账号的内容去标已读。每次调用都是一次新的拉取。
 */
export function beginAnnouncementFeed(account: string): AnnouncementLoad {
  if (feedAccount !== account) {
    feedAccount = account
    generation += 1
    localReads.clear()
    items = EMPTY_ITEMS
    unread = 0
    status = 'loading'
    emit()
  }
  return newLoad()
}

/** 标已读请求发出时记下；回来时带上，换过账号的结果会被丢掉。 */
export function currentAnnouncementFeed(): number {
  return generation
}

function overlayLocalReads(list: AnnouncementPublicItem[]): {
  items: AnnouncementPublicItem[]
  cleared: number
} {
  if (!localReads.size) return { items: list, cleared: 0 }
  let cleared = 0
  const next = list.map((item) => {
    const dismissed = localReads.get(item.id)
    if (dismissed === undefined) return item
    if (!item.unread && (!dismissed || item.dismissed)) return item
    if (item.unread) cleared += 1
    return { ...item, unread: false, dismissed: item.dismissed || dismissed }
  })
  return { items: next, cleared }
}

export function setAnnouncementFeed(
  list: AnnouncementPublicList,
  load: AnnouncementLoad = newLoad(),
): boolean {
  if (load.generation !== generation || load.seq < appliedSeq) return false
  appliedSeq = load.seq
  const merged = overlayLocalReads(list.items)
  items = merged.items
  unread = Math.max(0, list.unreadCount - merged.cleared)
  status = 'ready'
  emit()
  return true
}

/** 第一次就失败才换成错误态；已经有内容时保留上一份。过期请求不改状态。 */
export function setAnnouncementFeedError(load: AnnouncementLoad = newLoad()): void {
  if (load.generation !== generation || load.seq < appliedSeq) return
  if (items.length === 0) status = 'error'
  emit()
}

export function applyAnnouncementRead(
  ids: readonly string[],
  dismissed: boolean,
  feed = generation,
): boolean {
  if (feed !== generation) return false
  if (!ids.length) return true
  for (const id of ids) localReads.set(id, (localReads.get(id) ?? false) || dismissed)
  const idSet = new Set(ids)
  let changed = false
  const next = items.map((item) => {
    if (!idSet.has(item.id) || (!item.unread && (!dismissed || item.dismissed))) return item
    changed = true
    return { ...item, unread: false, dismissed: item.dismissed || dismissed }
  })
  if (!changed) return true
  items = next
  unread = next.filter((item) => item.unread).length
  emit()
  return true
}

export function subscribeAnnouncementPanel(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

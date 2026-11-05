import type {
  AnnouncementLocale,
  AnnouncementPublicList,
  LocalAnnouncementRead,
} from '@image-playground/shared'
import { applyLocalAnnouncementReads } from '@image-playground/shared'
import { authenticatedBffFetch } from '../../lib/authClient'
import { bffBaseUrl } from '../../lib/runtimeConfig'
import { applyAnnouncementRead, currentAnnouncementFeed } from './panel'

export const ANNOUNCEMENT_READS_KEY = 'aip.announcement-reads'
const MODAL_SESSION_KEY = 'aip.announcement-modal-shown'

export function announcementLocale(locale: string): AnnouncementLocale {
  return locale.startsWith('en') ? 'en' : 'zh'
}

export function readLocalAnnouncementReads(): Record<string, LocalAnnouncementRead> {
  try {
    const raw = localStorage.getItem(ANNOUNCEMENT_READS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, LocalAnnouncementRead>
  } catch {
    return {}
  }
}

export function writeLocalAnnouncementReads(
  ids: readonly string[],
  dismissed: boolean,
): Record<string, LocalAnnouncementRead> {
  const next = { ...readLocalAnnouncementReads() }
  const now = Date.now()
  for (const id of ids) {
    const current = next[id] ?? {}
    next[id] = {
      readAt: current.readAt ?? now,
      dismissedAt: dismissed ? (current.dismissedAt ?? now) : current.dismissedAt,
    }
  }
  localStorage.setItem(ANNOUNCEMENT_READS_KEY, JSON.stringify(next))
  return next
}

export function announcementModalShownThisSession(): boolean {
  try {
    return sessionStorage.getItem(MODAL_SESSION_KEY) === '1'
  } catch {
    return false
  }
}

export function rememberAnnouncementModalShown(): void {
  try {
    sessionStorage.setItem(MODAL_SESSION_KEY, '1')
  } catch {
    // 隐私模式写不进去时，这一次会话里最多再弹一次。
  }
}

export async function fetchAnnouncements(
  locale: AnnouncementLocale,
): Promise<AnnouncementPublicList> {
  const response = await authenticatedBffFetch(`${bffBaseUrl()}/api/announcements?locale=${locale}`)
  if (!response.ok) throw new Error('announcements_unavailable')
  return (await response.json()) as AnnouncementPublicList
}

export async function postAnnouncementReads(
  ids: readonly string[],
  dismissed: boolean,
): Promise<boolean> {
  const response = await authenticatedBffFetch(`${bffBaseUrl()}/api/announcements/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids, dismissed }),
  })
  return response.ok
}

export async function markAnnouncementFeed(
  ids: readonly string[],
  dismissed: boolean,
  signedIn: boolean,
): Promise<void> {
  if (!ids.length) return
  // 请求发出时的账号代；回来时账号换了就不能把结果写到别人的列表上。
  const feed = currentAnnouncementFeed()
  if (signedIn) {
    const ok = await postAnnouncementReads(ids, dismissed)
    if (!ok) writeLocalAnnouncementReads(ids, dismissed)
  } else {
    writeLocalAnnouncementReads(ids, dismissed)
  }
  applyAnnouncementRead(ids, dismissed, feed)
}

export function withLocalReads(
  list: AnnouncementPublicList,
  anonymous: boolean,
): AnnouncementPublicList {
  const items = applyLocalAnnouncementReads(list.items, readLocalAnnouncementReads(), anonymous)
  return { items, unreadCount: items.filter((item) => item.unread).length }
}

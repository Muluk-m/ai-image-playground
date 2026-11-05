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

/**
 * 标已读。永不抛错：调用方都是 `void markAnnouncementFeed(...)`。
 * - 匿名：写本地已读记录（只有匿名用户会读它）。
 * - 登录：服务端是唯一落点。同步失败不写本地——那份记录登录态不读，还会被之后的匿名用户当成自己的。
 *   本会话内的已读由 panel 记着，刷新后下一次打开更新页会再标一次。
 * - 内存列表总是更新，但只更新发起请求时的那个账号。
 */
export async function markAnnouncementFeed(
  ids: readonly string[],
  dismissed: boolean,
  signedIn: boolean,
): Promise<void> {
  if (!ids.length) return
  const feed = currentAnnouncementFeed()
  try {
    if (signedIn) await postAnnouncementReads(ids, dismissed)
    else writeLocalAnnouncementReads(ids, dismissed)
  } catch {
    // 离线或存储不可用：保持内存里的状态，不向外抛。
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

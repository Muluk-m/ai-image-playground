import { selectMajorAnnouncement } from '@image-playground/shared'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useAuth } from '../../auth/AuthContext'
import { currentLocale } from '../../i18n'
import { isChangelogPath } from '../../lib/appPaths'
import { usePathname } from '../../lib/pathname'
import { AnnouncementModal } from './AnnouncementModal'
import {
  announcementLocale,
  announcementModalShownThisSession,
  fetchAnnouncements,
  markAnnouncementFeed,
  withLocalReads,
} from './client'
import {
  announcementFeedStatus,
  announcementItems,
  beginAnnouncementFeed,
  setAnnouncementFeed,
  setAnnouncementFeedError,
  subscribeAnnouncementPanel,
} from './panel'

export function AnnouncementHost() {
  const user = useAuth().user
  const items = useSyncExternalStore(
    subscribeAnnouncementPanel,
    announcementItems,
    announcementItems,
  )
  const status = useSyncExternalStore(
    subscribeAnnouncementPanel,
    announcementFeedStatus,
    announcementFeedStatus,
  )
  const onChangelog = isChangelogPath(usePathname())
  const [modalId, setModalId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const feed = beginAnnouncementFeed(user?.id ?? 'anonymous')
    try {
      const remote = await fetchAnnouncements(announcementLocale(currentLocale()))
      const next = withLocalReads(remote, !user)
      if (!setAnnouncementFeed(next, feed)) return
      if (!announcementModalShownThisSession() && !isChangelogPath(window.location.pathname)) {
        const major = selectMajorAnnouncement(next.items)
        if (major) setModalId(major.id)
      }
    } catch {
      setAnnouncementFeedError(feed)
    }
  }, [user])

  useEffect(() => {
    setModalId(null)
    void reload()
  }, [reload])

  // 弹窗开着时跳到更新页：那一页就是完整列表，弹窗要收起，不能盖在页面上。
  useEffect(() => {
    if (onChangelog) setModalId(null)
  }, [onChangelog])

  const modal =
    status === 'ready' && !onChangelog ? (items.find((item) => item.id === modalId) ?? null) : null
  const extraUnread = items.filter((item) => item.unread && item.id !== modal?.id).length

  return modal ? (
    <AnnouncementModal
      item={modal}
      extraUnread={extraUnread}
      onSeen={(id) => void markAnnouncementFeed([id], true, Boolean(user))}
      onClose={() => setModalId(null)}
    />
  ) : null
}

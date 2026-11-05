import { selectMajorAnnouncement } from '@image-playground/shared'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useAuth } from '../../auth/AuthContext'
import { currentLocale } from '../../i18n'
import { isChangelogPath } from '../../lib/appPaths'
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
  const [modalId, setModalId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const remote = await fetchAnnouncements(announcementLocale(currentLocale()))
      const next = withLocalReads(remote, !user)
      setAnnouncementFeed(next)
      if (!announcementModalShownThisSession() && !isChangelogPath(window.location.pathname)) {
        const major = selectMajorAnnouncement(next.items)
        if (major) setModalId(major.id)
      }
    } catch {
      setAnnouncementFeedError()
    }
  }, [user])

  useEffect(() => {
    void reload()
  }, [reload])

  const modal = status === 'ready' ? (items.find((item) => item.id === modalId) ?? null) : null
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

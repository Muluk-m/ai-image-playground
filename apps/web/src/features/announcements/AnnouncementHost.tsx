import type { AnnouncementPublicList } from '@image-playground/shared'
import { selectMajorAnnouncement } from '@image-playground/shared'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useAuth } from '../../auth/AuthContext'
import { currentLocale } from '../../i18n'
import { AnnouncementDrawer } from './AnnouncementDrawer'
import { AnnouncementModal } from './AnnouncementModal'
import {
  announcementLocale,
  announcementModalShownThisSession,
  fetchAnnouncements,
  postAnnouncementReads,
  withLocalReads,
  writeLocalAnnouncementReads,
} from './client'
import {
  announcementPanelOpen,
  setAnnouncementUnreadCount,
  subscribeAnnouncementPanel,
} from './panel'

export function AnnouncementHost() {
  const user = useAuth().user
  const open = useSyncExternalStore(subscribeAnnouncementPanel, announcementPanelOpen, () => false)
  const [list, setList] = useState<AnnouncementPublicList>({ items: [], unreadCount: 0 })
  const [error, setError] = useState(false)
  const [modalId, setModalId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const remote = await fetchAnnouncements(announcementLocale(currentLocale()))
      const next = withLocalReads(remote, !user)
      setList(next)
      setError(false)
      if (!announcementModalShownThisSession() && !open) {
        const major = selectMajorAnnouncement(next.items)
        if (major) setModalId(major.id)
      }
    } catch {
      setError(true)
    }
  }, [open, user])

  useEffect(() => {
    void reload()
  }, [reload])

  async function mark(ids: string[], dismissed: boolean) {
    if (!ids.length) return
    if (user) {
      const ok = await postAnnouncementReads(ids, dismissed)
      if (!ok) writeLocalAnnouncementReads(ids, dismissed)
    } else {
      writeLocalAnnouncementReads(ids, dismissed)
    }
    setList((current) => {
      const items = current.items.map((item) =>
        ids.includes(item.id)
          ? { ...item, unread: false, dismissed: item.dismissed || dismissed }
          : item,
      )
      return { items, unreadCount: items.filter((item) => item.unread).length }
    })
  }

  useEffect(() => {
    setAnnouncementUnreadCount(list.unreadCount)
  }, [list.unreadCount])

  const modal = list.items.find((item) => item.id === modalId) ?? null
  const extraUnread = list.items.filter((item) => item.unread && item.id !== modal?.id).length

  return (
    <>
      <AnnouncementDrawer
        open={open}
        items={list.items}
        unreadCount={list.unreadCount}
        error={error}
        onMark={(ids, dismissed) => void mark(ids, dismissed)}
      />
      {modal && !open ? (
        <AnnouncementModal
          item={modal}
          extraUnread={extraUnread}
          onSeen={(id) => void mark([id], true)}
          onClose={() => setModalId(null)}
        />
      ) : null}
    </>
  )
}

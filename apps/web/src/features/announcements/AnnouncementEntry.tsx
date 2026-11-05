import { useSyncExternalStore } from 'react'
import { Button } from '../../components/ui/button'
import { Icon } from '../../components/ui/icon'
import { useTranslation } from '../../i18n'
import {
  announcementUnreadCount,
  setAnnouncementPanelOpen,
  subscribeAnnouncementPanel,
} from './panel'

export function AnnouncementEntry({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation('announcements')
  const unread = useSyncExternalStore(subscribeAnnouncementPanel, announcementUnreadCount, () => 0)
  if (compact) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t('entry')}
        onClick={() => setAnnouncementPanelOpen(true)}
        className="relative size-10 shrink-0 text-muted-foreground"
      >
        <Icon name="notify" />
        {unread > 0 ? <UnreadDot label={t('unreadDot')} /> : null}
      </Button>
    )
  }
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => setAnnouncementPanelOpen(true)}
      className="h-8 w-full justify-start gap-2 px-3 text-xs font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
    >
      <Icon name="notify" size="xs" />
      <span className="min-w-0 flex-1 truncate text-left">{t('entry')}</span>
      {unread > 0 ? <UnreadDot label={t('unreadDot')} /> : null}
    </Button>
  )
}

export function AnnouncementMenuRow({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation('announcements')
  const unread = useSyncExternalStore(subscribeAnnouncementPanel, announcementUnreadCount, () => 0)
  return (
    <Button
      type="button"
      variant="ghost"
      role="menuitem"
      onClick={() => {
        onOpen()
        setAnnouncementPanelOpen(true)
      }}
      className="h-11 w-full justify-start gap-3 px-2 font-normal text-foreground"
    >
      <Icon name="notify" className="text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-left">{t('entry')}</span>
      {unread > 0 ? <UnreadDot label={t('unreadDot')} /> : null}
      <Icon name="chevronRight" className="text-muted-foreground" />
    </Button>
  )
}

function UnreadDot({ label }: { label: string }) {
  return <span role="img" aria-label={label} className="size-2 shrink-0 rounded-full bg-primary" />
}

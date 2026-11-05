import type { AnnouncementPublicItem } from '@image-playground/shared'
import { useEffect, useSyncExternalStore } from 'react'
import { useAuth } from '../../auth/AuthContext'
import EmptyState from '../../components/patterns/EmptyState'
import PageHeader from '../../components/patterns/PageHeader'
import { Button } from '../../components/ui/button'
import { Icon } from '../../components/ui/icon'
import { i18next, setDocumentTitleOverride, useTranslation } from '../../i18n'
import { navigate } from '../../lib/pathname'
import { AnnouncementBody } from './AnnouncementBody'
import {
  announcementLocale,
  fetchAnnouncements,
  markAnnouncementFeed,
  withLocalReads,
} from './client'
import {
  announcementFeedStatus,
  announcementItems,
  currentAnnouncementEpoch,
  setAnnouncementFeed,
  setAnnouncementFeedError,
  subscribeAnnouncementPanel,
} from './panel'

function formatPublished(ms: number | null, locale: string): string {
  if (ms == null) return ''
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(ms))
}

function isVideoUrl(url: string): boolean {
  const path = url.split(/[?#]/, 1)[0] ?? url
  return /\.(mp4|webm|mov)$/i.test(path)
}

function UpdateMedia({ url, title }: { url: string; title: string }) {
  if (isVideoUrl(url)) {
    return (
      <video
        src={url}
        controls
        playsInline
        preload="metadata"
        aria-label={title}
        className="aspect-video w-full rounded-2xl bg-card object-cover"
      />
    )
  }
  return (
    <img src={url} alt={title} className="aspect-video w-full rounded-2xl bg-card object-cover" />
  )
}

function UpdateEntry({ item, locale }: { item: AnnouncementPublicItem; locale: string }) {
  const when = formatPublished(item.publishAt, locale)
  return (
    <article data-slot="changelog-entry" className="border-b border-border pb-8">
      <div
        className={item.coverUrl ? 'grid items-start gap-8 lg:grid-cols-2 lg:gap-12' : 'max-w-xl'}
      >
        <div className="min-w-0">
          {item.versionTag ? (
            <p className="inline-flex h-7 items-center rounded-full border border-border px-3 text-label-md text-foreground">
              {item.versionTag}
            </p>
          ) : null}
          {when ? <p className="mt-4 text-body-sm text-muted-foreground">{when}</p> : null}
          <h2 className="mt-8 text-xl font-semibold text-foreground">{item.title}</h2>
          <div className="mt-4">
            <AnnouncementBody source={item.body} ordered />
          </div>
          {item.ctaLabel && item.ctaUrl ? (
            <Button
              type="button"
              variant="secondary"
              className="mt-6"
              onClick={() => navigate(item.ctaUrl as string)}
            >
              {item.ctaLabel}
              <Icon name="chevronRight" size="xs" />
            </Button>
          ) : null}
        </div>
        {item.coverUrl ? (
          <div data-slot="changelog-media" className="min-w-0">
            <UpdateMedia url={item.coverUrl} title={item.title} />
          </div>
        ) : null}
      </div>
    </article>
  )
}

/**
 * 更新页挂在工作台主区里（侧栏仍在），一条一条按 LibTV：版本、日期、标题、编号、按钮，
 * 有演示时放在右侧。
 */
export default function ChangelogPage() {
  const { t, i18n } = useTranslation('announcements')
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

  useEffect(() => {
    setDocumentTitleOverride(() => i18next.t('documentTitle', { ns: 'announcements' }))
    return () => setDocumentTitleOverride(null)
  }, [])

  useEffect(() => {
    const epoch = currentAnnouncementEpoch()
    let cancelled = false
    void fetchAnnouncements(announcementLocale(i18n.language))
      .then((list) => {
        if (!cancelled) setAnnouncementFeed(withLocalReads(list, !user), epoch)
      })
      .catch(() => {
        if (!cancelled) setAnnouncementFeedError(epoch)
      })
    return () => {
      cancelled = true
    }
  }, [i18n.language, user])

  useEffect(() => {
    if (status !== 'ready') return
    const ids = items.filter((item) => item.unread).map((item) => item.id)
    if (!ids.length) return
    void markAnnouncementFeed(ids, false, Boolean(user))
  }, [items, status, user])

  return (
    <main className="flex h-[calc(100dvh-var(--mobile-nav-height,0px)-var(--mobile-topbar-height,0px)-var(--app-inset,0px)*2)] flex-col bg-background">
      <PageHeader title={t('changelogTitle')} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
        {status === 'error' ? (
          <p className="text-body-sm text-muted-foreground">{t('loadError')}</p>
        ) : null}
        {status === 'ready' && items.length === 0 ? (
          <EmptyState icon={<Icon name="notify" size="lg" />} title={t('empty')} />
        ) : null}
        <div className="flex flex-col gap-12">
          {items.map((item) => (
            <UpdateEntry key={item.id} item={item} locale={i18n.language} />
          ))}
        </div>
      </div>
    </main>
  )
}

import type { AnnouncementPublicItem, AnnouncementType } from '@image-playground/shared'
import { useState } from 'react'
import { Button } from '../../components/ui/button'
import { Icon } from '../../components/ui/icon'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../../components/ui/sheet'
import { useTranslation } from '../../i18n'
import { CHANGELOG_PATH } from '../../lib/appPaths'
import { navigate } from '../../lib/pathname'
import { AnnouncementBody } from './AnnouncementBody'
import { setAnnouncementPanelOpen } from './panel'

const FILTERS = ['all', 'feature', 'improvement', 'notice'] as const

export const FILTER_KEY = {
  all: 'filters.all',
  feature: 'filters.feature',
  improvement: 'filters.improvement',
  notice: 'filters.notice',
} as const

function formatWhen(ms: number | null, locale: string): string {
  if (ms == null) return ''
  return new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(new Date(ms))
}

export function AnnouncementDrawer({
  open,
  items,
  unreadCount,
  error,
  onMark,
}: {
  open: boolean
  items: AnnouncementPublicItem[]
  unreadCount: number
  error: boolean
  onMark: (ids: string[], dismissed: boolean) => void
}) {
  const { t, i18n } = useTranslation('announcements')
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all')
  const visible = items.filter((item) => filter === 'all' || item.type === filter)

  return (
    <Sheet open={open} onOpenChange={setAnnouncementPanelOpen}>
      <SheetContent
        side="left"
        closeLabel={t('close')}
        className="w-full gap-0 overflow-y-auto p-0 sm:max-w-sm"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <SheetTitle className="text-title">{t('title')}</SheetTitle>
          <SheetDescription className="sr-only">{t('title')}</SheetDescription>
          <span className="text-label-sm text-muted-foreground">
            {unreadCount > 0 ? t('unreadCount', { count: unreadCount }) : null}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((value) => (
              <Button
                key={value}
                type="button"
                size="xs"
                variant={filter === value ? 'default' : 'outline'}
                onClick={() => setFilter(value)}
              >
                {t(FILTER_KEY[value])}
              </Button>
            ))}
          </div>
        </div>
        <div className="px-4 pb-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-0 text-muted-foreground"
            disabled={unreadCount === 0}
            onClick={() =>
              onMark(
                items.map((item) => item.id),
                false,
              )
            }
          >
            {t('markAll')}
          </Button>
        </div>
        {error ? <p className="px-4 text-body-sm text-muted-foreground">{t('loadError')}</p> : null}
        {!error && visible.length === 0 ? (
          <p className="px-4 text-body-sm text-muted-foreground">{t('empty')}</p>
        ) : null}
        <div className="space-y-5 px-4 pb-4">
          {visible.map((item) => (
            <AnnouncementCard key={item.id} item={item} locale={i18n.language} onMark={onMark} />
          ))}
        </div>
        <div className="border-t border-border px-4 py-3">
          <Button
            type="button"
            variant="ghost"
            className="h-9 w-full justify-between px-0 font-normal text-muted-foreground"
            onClick={() => {
              setAnnouncementPanelOpen(false)
              navigate(CHANGELOG_PATH)
            }}
          >
            {t('viewAll')}
            <Icon name="chevronRight" size="xs" />
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function AnnouncementCard({
  item,
  locale,
  onMark,
}: {
  item: AnnouncementPublicItem
  locale: string
  onMark: (ids: string[], dismissed: boolean) => void
}) {
  const { t } = useTranslation('announcements')
  const meta = [item.versionTag, formatWhen(item.publishAt, locale)].filter(Boolean).join(' · ')
  return (
    <article>
      {item.coverUrl ? (
        <img
          src={item.coverUrl}
          alt=""
          className="mb-3 aspect-video w-full rounded-lg object-cover"
        />
      ) : null}
      <p className="text-label-sm text-primary">
        {t(FILTER_KEY[item.type as AnnouncementType])}
        {meta ? ` · ${meta}` : ''}
      </p>
      <h3 className="mt-1 text-sm font-medium">{item.title}</h3>
      <div className="mt-2">
        <AnnouncementBody source={item.body} />
      </div>
      {item.ctaLabel && item.ctaUrl ? (
        <Button
          type="button"
          variant="link"
          className="mt-1 h-auto px-0"
          onClick={() => {
            onMark([item.id], false)
            setAnnouncementPanelOpen(false)
            navigate(item.ctaUrl!)
          }}
        >
          {item.ctaLabel}
        </Button>
      ) : null}
    </article>
  )
}

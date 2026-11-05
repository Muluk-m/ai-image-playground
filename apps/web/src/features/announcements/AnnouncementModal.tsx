import type { AnnouncementPublicItem } from '@image-playground/shared'
import { useEffect, useRef } from 'react'
import { Button } from '../../components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../../components/ui/sheet'
import { useTranslation } from '../../i18n'
import { CHANGELOG_PATH } from '../../lib/appPaths'
import { navigate } from '../../lib/pathname'
import { AnnouncementBody } from './AnnouncementBody'
import { rememberAnnouncementModalShown } from './client'
import { FILTER_KEY } from './labels'

function formatWhen(ms: number | null, locale: string): string {
  if (ms == null) return ''
  return new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(new Date(ms))
}

export function AnnouncementModal({
  item,
  extraUnread,
  onSeen,
  onClose,
}: {
  item: AnnouncementPublicItem
  extraUnread: number
  onSeen: (id: string) => void
  onClose: () => void
}) {
  const { t, i18n } = useTranslation('announcements')
  const onSeenRef = useRef(onSeen)
  onSeenRef.current = onSeen
  useEffect(() => {
    rememberAnnouncementModalShown()
    onSeenRef.current(item.id)
  }, [item.id])

  const meta = [item.versionTag, formatWhen(item.publishAt, i18n.language)]
    .filter(Boolean)
    .join(' · ')

  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <SheetContent
        side="left"
        closeLabel={t('close')}
        className="inset-auto left-1/2 top-1/2 h-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl border border-border bg-card p-4 shadow-dialog"
      >
        <SheetTitle className="sr-only">{item.title}</SheetTitle>
        <SheetDescription className="sr-only">{item.title}</SheetDescription>
        {item.coverUrl ? (
          <img src={item.coverUrl} alt="" className="aspect-video w-full rounded-xl object-cover" />
        ) : null}
        <p className="mt-3 text-label-sm text-primary">
          {t(FILTER_KEY[item.type])}
          {meta ? ` · ${meta}` : ''}
        </p>
        <h2 className="mt-1 text-base font-medium">{item.title}</h2>
        <div className="mt-2">
          <AnnouncementBody source={item.body} />
        </div>
        {extraUnread > 0 ? (
          <Button
            type="button"
            variant="link"
            className="mt-2 h-auto px-0 text-muted-foreground"
            onClick={() => {
              onClose()
              navigate(CHANGELOG_PATH)
            }}
          >
            {t('more', { count: extraUnread })}
          </Button>
        ) : null}
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('later')}
          </Button>
          {item.ctaLabel && item.ctaUrl ? (
            <Button
              type="button"
              onClick={() => {
                onClose()
                navigate(item.ctaUrl as string)
              }}
            >
              {item.ctaLabel}
            </Button>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

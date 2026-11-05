import type { AnnouncementPublicItem } from '@image-playground/shared'
import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext'
import { Button } from '../../components/ui/button'
import { i18next, setDocumentTitleOverride, useTranslation } from '../../i18n'
import { navigate } from '../../lib/pathname'
import { AnnouncementBody } from './AnnouncementBody'
import { FILTER_KEY } from './AnnouncementDrawer'
import { announcementLocale, fetchAnnouncements, withLocalReads } from './client'

export default function ChangelogPage() {
  const { t } = useTranslation('announcements')
  const user = useAuth().user
  const [items, setItems] = useState<AnnouncementPublicItem[]>([])
  const [error, setError] = useState(false)

  useEffect(() => {
    setDocumentTitleOverride(() => i18next.t('documentTitle', { ns: 'announcements' }))
    return () => setDocumentTitleOverride(null)
  }, [])

  useEffect(() => {
    let cancelled = false
    void fetchAnnouncements(announcementLocale(i18next.language))
      .then((list) => {
        if (!cancelled) setItems(withLocalReads(list, !user).items)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [user])

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 px-6 py-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-medium">{t('changelogTitle')}</h1>
        <Button type="button" variant="outline" onClick={() => navigate('/image')}>
          {t('back')}
        </Button>
      </div>
      {error ? <p className="text-body-sm text-muted-foreground">{t('loadError')}</p> : null}
      {!error && items.length === 0 ? (
        <p className="text-body-sm text-muted-foreground">{t('empty')}</p>
      ) : null}
      <div className="space-y-8">
        {items.map((item) => {
          const when = item.publishAt
            ? new Intl.DateTimeFormat(i18next.language, {
                month: 'numeric',
                day: 'numeric',
              }).format(new Date(item.publishAt))
            : ''
          return (
            <article key={item.id} className="border-b border-border pb-8">
              {item.coverUrl ? (
                <img
                  src={item.coverUrl}
                  alt=""
                  className="mb-4 aspect-video w-full rounded-xl object-cover"
                />
              ) : null}
              <p className="text-label-sm text-primary">
                {t(FILTER_KEY[item.type])}
                {item.versionTag || when
                  ? ` · ${[item.versionTag, when].filter(Boolean).join(' · ')}`
                  : ''}
              </p>
              <h2 className="mt-1 text-base font-medium">{item.title}</h2>
              <div className="mt-3">
                <AnnouncementBody source={item.body} />
              </div>
            </article>
          )
        })}
      </div>
    </main>
  )
}

import type { GenerationDetail, GenerationPage } from '@image-playground/shared'
import { Cloud, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from '../i18n'
import { authenticatedBffFetch } from '../lib/authClient'
import { scopedStorageName } from '../lib/authScope'
import { bffBaseUrl } from '../lib/runtimeConfig'
import { Button } from './ui/button'

export default function CloudGenerationHistory() {
  const { t, i18n } = useTranslation(['task', 'errors'])
  const [page, setPage] = useState<GenerationPage>({ items: [], nextCursor: null })
  const [trail, setTrail] = useState<string[]>([''])
  const [detail, setDetail] = useState<GenerationDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const request = useRef<AbortController | null>(null)
  const scope = scopedStorageName('generation-history')
  const current = useCallback(
    (controller: AbortController) =>
      !controller.signal.aborted && scopedStorageName('generation-history') === scope,
    [scope],
  )

  const load = useCallback(
    async (cursor = '', nextTrail = ['']) => {
      request.current?.abort()
      const controller = new AbortController()
      request.current = controller
      setLoading(true)
      setFailed(false)
      setDetail(null)
      try {
        const response = await authenticatedBffFetch(
          `${bffBaseUrl()}/api/generations?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          {
            cache: 'no-store',
            signal: controller.signal,
          },
        )
        if (!response.ok) throw new Error('load_failed')
        const next: GenerationPage = await response.json()
        if (current(controller)) {
          setPage(next)
          setTrail(nextTrail)
        }
      } catch {
        if (current(controller)) setFailed(true)
      } finally {
        if (current(controller)) setLoading(false)
      }
    },
    [current],
  )

  useEffect(() => {
    void load()
    return () => request.current?.abort()
  }, [load])

  async function open(id: string) {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setFailed(false)
    setDetail(null)
    try {
      const response = await authenticatedBffFetch(
        `${bffBaseUrl()}/api/generations/${encodeURIComponent(id)}`,
        {
          cache: 'no-store',
          signal: controller.signal,
        },
      )
      if (!response.ok) throw new Error('load_failed')
      const next: GenerationDetail = await response.json()
      if (current(controller)) setDetail(next)
    } catch {
      if (current(controller)) setFailed(true)
    } finally {
      if (current(controller)) setLoading(false)
    }
  }

  return (
    <section className="space-y-4 py-6" aria-label={t('cloudHistory.title')}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            <Cloud size={18} />
            {t('cloudHistory.title')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('cloudHistory.description')}</p>
        </div>
        <Button variant="outline" onClick={() => void load()}>
          <RefreshCw size={16} />
          {t('cloudHistory.refresh')}
        </Button>
      </div>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {t('errors:generations.fallback')}
        </p>
      )}
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('cloudHistory.loading')}
        </p>
      )}
      {!loading && !failed && !page.items.length && (
        <p className="py-16 text-center text-muted-foreground">{t('cloudHistory.empty')}</p>
      )}
      <ul className="space-y-3">
        {page.items.map((item) => (
          <li key={item.id} className="rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium">{item.model}</p>
                <time
                  dateTime={new Date(item.createdAt).toISOString()}
                  className="text-xs text-muted-foreground"
                >
                  {new Date(item.createdAt).toLocaleString(i18n.language)}
                </time>
              </div>
              <div className="flex items-center gap-3">
                <span className="rounded-full bg-muted px-3 py-1 text-xs">
                  {t(`cloudHistory.status.${item.status}`)}
                </span>
                <Button variant="ghost" disabled={loading} onClick={() => void open(item.id)}>
                  {t('cloudHistory.details')}
                </Button>
              </div>
            </div>
            {detail?.id === item.id && (
              <p className="mt-4 whitespace-pre-wrap break-words border-t border-border pt-4 text-sm">
                {detail.prompt}
              </p>
            )}
          </li>
        ))}
      </ul>
      {(trail.length > 1 || page.nextCursor) && (
        <nav className="flex justify-end gap-2" aria-label={t('cloudHistory.pages')}>
          <Button
            variant="outline"
            disabled={loading || trail.length === 1}
            onClick={() => void load(trail[trail.length - 2] ?? '', trail.slice(0, -1))}
          >
            {t('cloudHistory.previous')}
          </Button>
          <Button
            variant="outline"
            disabled={loading || !page.nextCursor}
            onClick={() => {
              if (page.nextCursor) void load(page.nextCursor, [...trail, page.nextCursor])
            }}
          >
            {t('cloudHistory.next')}
          </Button>
        </nav>
      )}
    </section>
  )
}

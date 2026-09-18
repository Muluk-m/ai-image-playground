import type { RecycledProject } from '@image-playground/shared'
import { useEffect, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { formatDate } from '../../../i18n/format'
import { scopedStorageName } from '../../../lib/authScope'
import { listRecycledCloudProjects } from '../lib/projectClient'
import { type CanvasProject, projectDisplayName } from '../lib/projectRepository'
import { copyDeletedProjectLocally } from '../lib/workspaces'
import { useCanvasProjectStore } from '../projectStore'

export default function ProjectTrash({
  onBack,
  onOpen,
}: {
  onBack(): void
  onOpen(project: CanvasProject): Promise<void>
}) {
  const { t } = useTranslation(['canvas', 'errors'])
  const locals = useCanvasProjectStore((state) => state.projects)
  const [projects, setProjects] = useState<RecycledProject[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const scope = scopedStorageName('canvas')
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void listRecycledCloudProjects()
      .then(
        (page) => {
          if (cancelled || scopedStorageName('canvas') !== scope) return
          setProjects(page.projects)
          setCursor(page.nextCursor)
        },
        () => {
          if (!cancelled) setError(true)
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [scope])
  const copy = async (id: string) => {
    if (busy) return
    setBusy(true)
    setError(false)
    try {
      const project = await copyDeletedProjectLocally(id)
      if (scopedStorageName('canvas') === scope) await onOpen(project)
    } catch {
      if (scopedStorageName('canvas') === scope) setError(true)
    } finally {
      setBusy(false)
    }
  }
  const restore = async (id: string) => {
    if (busy) return
    setBusy(true)
    setError(false)
    try {
      await useCanvasProjectStore.getState().restore(id)
      if (scopedStorageName('canvas') !== scope) return
      setProjects((all) => all.filter((one) => one.id !== id))
    } catch {
      if (scopedStorageName('canvas') === scope) setError(true)
    } finally {
      setBusy(false)
    }
  }
  const more = async () => {
    if (busy) return
    setBusy(true)
    try {
      const page = await listRecycledCloudProjects(cursor ?? undefined)
      if (scopedStorageName('canvas') !== scope) return
      setProjects((all) => [
        ...all.filter((one) => !page.projects.some((next) => next.id === one.id)),
        ...page.projects,
      ])
      setCursor(page.nextCursor)
      setError(false)
    } catch {
      if (scopedStorageName('canvas') === scope) setError(true)
    } finally {
      setBusy(false)
    }
  }
  const localCopies = locals.filter(
    (one) => one.cloud?.deleted && !projects.some((remote) => remote.id === one.id),
  )
  return (
    <section aria-label={t('trash.title')} className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="outline" onClick={onBack}>
          {t('trash.back')}
        </Button>
        <h3 className="font-medium">{t('trash.title')}</h3>
      </div>
      <p className="text-sm text-muted-foreground">{t('trash.help')}</p>
      {loading && <p role="status">{t('grid.loadingCloud')}</p>}
      {error && (
        <div role="alert">
          {t('errors:projectRecycle.fallback')}{' '}
          <Button variant="link" disabled={busy} onClick={() => void more()}>
            {t('grid.retryCloud')}
          </Button>
        </div>
      )}
      {!loading && !projects.length && !localCopies.length && (
        <p className="py-8 text-muted-foreground">{t('trash.empty')}</p>
      )}
      {projects.map((project) => {
        const local = locals.find((one) => one.id === project.id)
        return (
          <article
            key={project.id}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-4"
          >
            <div className="min-w-0 flex-1">
              <h4 className="truncate">{projectDisplayName(project.name)}</h4>
              <p className="text-xs text-muted-foreground">
                {t('trash.until', { date: formatDate(project.restoreUntil) })}
              </p>
            </div>
            {local?.cloud?.deleted && (
              <Button variant="ghost" disabled={busy} onClick={() => void copy(local.id)}>
                {t('trash.localEdits')}
              </Button>
            )}
            <Button variant="outline" disabled={busy} onClick={() => void restore(project.id)}>
              {t('trash.restore')}
            </Button>
          </article>
        )
      })}
      {cursor && (
        <Button variant="outline" disabled={busy} onClick={() => void more()}>
          {t('grid.loadMore')}
        </Button>
      )}
      {localCopies.map((project) => (
        <article
          key={project.id}
          className="flex items-center gap-3 rounded-xl border border-border p-4"
        >
          <span className="min-w-0 flex-1 truncate">{projectDisplayName(project.name)}</span>
          <Button variant="outline" disabled={busy} onClick={() => void copy(project.id)}>
            {t('trash.localEdits')}
          </Button>
        </article>
      ))}
    </section>
  )
}

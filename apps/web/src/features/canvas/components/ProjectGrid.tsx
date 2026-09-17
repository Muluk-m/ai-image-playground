import { useState } from 'react'
import { PlusIcon, TrashIcon } from '../../../components/icons'
import { useTranslation } from '../../../i18n'
import { formatDate } from '../../../i18n/format'
import { useStore } from '../../../store'
import { useAgentStore } from '../../agent/store'
import NamingDialog from '../../library/components/NamingDialog'
import { useLibraryStore } from '../../library/store'
import { projectCatalog } from '../lib/projectCatalog'
import { cloudProjectsEnabled } from '../lib/projectClient'
import { type CanvasProject, projectDisplayName } from '../lib/projectRepository'
import { useCanvasProjectStore } from '../projectStore'

export default function ProjectGrid({
  search = '',
  recent = false,
}: {
  search?: string
  recent?: boolean
}) {
  const { t } = useTranslation('canvas')
  const projects = useCanvasProjectStore((state) => state.projects)
  const activeId = useCanvasProjectStore((state) => state.activeId)
  const cloudError = useCanvasProjectStore((state) => state.cloudError)
  const cloudLoading = useCanvasProjectStore((state) => state.cloudLoading)
  const cloudCursor = useCanvasProjectStore((state) => state.cloudCursor)
  const cloudCatalog = useCanvasProjectStore((state) => state.cloudCatalog)
  const [renaming, setRenaming] = useState<CanvasProject | null>(null)
  const [busy, setBusy] = useState(false)
  const visible = projectCatalog(projects, cloudCatalog)
    .filter(
      (project) =>
        project.name.toLowerCase().includes(search.trim().toLowerCase()) &&
        (!recent || project.hasContent),
    )
    .slice(0, recent ? 5 : undefined)
  const enter = async (project?: CanvasProject) => {
    if (busy) return
    setBusy(true)
    try {
      const opened = project
        ? await useAgentStore.getState().selectProject(project.id)
        : await useAgentStore.getState().createProject()
      if (opened) {
        useStore.getState().setAppMode('create')
        useLibraryStore.getState().closePanel()
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {cloudProjectsEnabled() && (
        <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {cloudError && <span role="alert">{cloudError}</span>}
          <button
            type="button"
            disabled={cloudLoading}
            className="underline disabled:opacity-50"
            onClick={() => void useCanvasProjectStore.getState().refreshCloud()}
          >
            {cloudLoading
              ? t('grid.loadingCloud')
              : cloudError
                ? t('grid.retryCloud')
                : t('grid.refreshCloud')}
          </button>
          {cloudCursor && (
            <button
              type="button"
              disabled={cloudLoading}
              className="underline disabled:opacity-50"
              onClick={() => void useCanvasProjectStore.getState().refreshCloud(true)}
            >
              {t('grid.loadMore')}
            </button>
          )}
        </div>
      )}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {!search && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void enter()}
            className="group flex min-h-48 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-muted/30 text-muted-foreground transition hover:border-primary/60 hover:bg-muted disabled:opacity-50"
          >
            <PlusIcon className="h-8 w-8 transition group-hover:text-primary" />
            <span className="text-sm font-medium">{t('grid.newProject')}</span>
          </button>
        )}
        {visible.map((project) => (
          <article
            key={project.id}
            className="group overflow-hidden rounded-2xl border border-border bg-card transition hover:border-primary/50"
          >
            <button
              type="button"
              disabled={busy}
              aria-label={t('grid.openAria', { name: projectDisplayName(project.name) })}
              onClick={() => void enter(project)}
              className="block w-full text-left disabled:opacity-50"
            >
              <div className="relative flex aspect-[16/10] items-center justify-center overflow-hidden bg-muted/50">
                {project.cover ? (
                  <img
                    src={project.cover}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <span className="text-4xl text-muted-foreground/40" aria-hidden="true">
                    ✧
                  </span>
                )}
                {project.id === activeId && (
                  <span className="absolute left-3 top-3 rounded-full bg-background/90 px-2 py-1 text-[10px] text-muted-foreground">
                    {t('grid.current')}
                  </span>
                )}
              </div>
              <h3
                className="truncate px-4 pt-3 text-sm font-medium text-foreground"
                title={projectDisplayName(project.name)}
              >
                {projectDisplayName(project.name)}
              </h3>
            </button>
            <div className="flex items-center gap-2 px-4 pb-3 pt-1.5 text-xs text-muted-foreground">
              <time
                className="min-w-0 flex-1 truncate"
                dateTime={new Date(project.updatedAt).toISOString()}
              >
                {t('grid.updatedAt', { date: formatDate(project.updatedAt) })}
              </time>
              <span>
                {project.cloud
                  ? project.cloud.revision > 0
                    ? t('grid.cloud')
                    : t('grid.pendingSync')
                  : t('grid.localOnly')}
              </span>
              <button
                type="button"
                className="rounded px-1.5 py-1 hover:bg-muted hover:text-foreground"
                onClick={() => setRenaming(project)}
                aria-label={t('grid.renameAria', { name: projectDisplayName(project.name) })}
              >
                {t('grid.rename')}
              </button>
              {!recent && !project.cloud && (
                <button
                  type="button"
                  className="rounded p-1 hover:bg-muted hover:text-destructive"
                  aria-label={t('grid.deleteAria', { name: projectDisplayName(project.name) })}
                  onClick={() =>
                    useStore.getState().setConfirmDialog({
                      title: t('grid.deleteTitle'),
                      message: t('grid.deleteMessage', {
                        name: projectDisplayName(project.name),
                      }),
                      action: () => {
                        void useAgentStore.getState().deleteProject(project.id)
                      },
                    })
                  }
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {search && !visible.length && (
        <p className="py-16 text-center text-sm text-muted-foreground">{t('grid.noMatch')}</p>
      )}
      {renaming && (
        <NamingDialog
          title={t('grid.renameTitle')}
          placeholder={t('grid.renamePlaceholder')}
          defaultName={projectDisplayName(renaming.name)}
          onCancel={() => setRenaming(null)}
          onSave={(name) => {
            void useCanvasProjectStore
              .getState()
              .update(renaming.id, { name, customName: true })
              .then(
                () => setRenaming(null),
                () => useStore.getState().showToast(t('grid.renameFailed'), 'error'),
              )
          }}
        />
      )}
    </>
  )
}

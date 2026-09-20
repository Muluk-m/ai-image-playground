import { MoreHorizontal, Pencil } from 'lucide-react'
import { useState } from 'react'
import { PlusIcon, TrashIcon } from '../../../components/icons'
import MediaImage from '../../../components/MediaImage'
import { Button } from '../../../components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover'
import { useTranslation } from '../../../i18n'
import { formatDate } from '../../../i18n/format'
import { isVideoModeAvailable } from '../../../lib/channels/videoChannels'
import { useStore } from '../../../store'
import { useAgentStore } from '../../agent/store'
import NamingDialog from '../../library/components/NamingDialog'
import { useLibraryStore } from '../../library/store'
import { projectCatalog } from '../lib/projectCatalog'
import { cloudProjectsEnabled } from '../lib/projectClient'
import { type CanvasProject, projectDisplayName } from '../lib/projectRepository'
import { useCanvasProjectStore } from '../projectStore'
import ProjectTrash from './ProjectTrash'

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
  const [trash, setTrash] = useState(false)
  const [renaming, setRenaming] = useState<CanvasProject | null>(null)
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const visible = projectCatalog(projects, cloudCatalog)
    .filter(
      (project) =>
        project.name.toLowerCase().includes(search.trim().toLowerCase()) &&
        (!recent || project.hasContent),
    )
    .slice(0, recent ? 5 : undefined)
  const enter = async (project?: CanvasProject, kind?: 'image' | 'video') => {
    if (busy) return
    setBusy(true)
    try {
      const opened = project
        ? await useAgentStore.getState().selectProject(project.id)
        : await useAgentStore.getState().createProject(kind)
      if (opened) {
        // 挑中或建出项目就落到画布——项目的唯一去处就是它自己的工作台。
        useStore.getState().setAppMode('canvas')
        useLibraryStore.getState().leaveLibraryPage()
      }
    } finally {
      setBusy(false)
    }
  }
  if (trash) return <ProjectTrash onBack={() => setTrash(false)} onOpen={enter} />
  return (
    <>
      {cloudProjectsEnabled() && (
        <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {!recent && (
            <Button variant="ghost" size="sm" onClick={() => setTrash(true)}>
              <TrashIcon className="h-4 w-4" />
              {t('trash.title')}
            </Button>
          )}
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
        {!search && !recent && (
          <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-muted/30 text-muted-foreground">
            <PlusIcon className="h-8 w-8" />
            <span className="text-sm font-medium">{t('grid.newProject')}</span>
            {/* 画布类型建后不可改，所以在这里问一次，而不是进去再切。 */}
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => void enter(undefined, 'image')}>
                {t('project.kindImage')}
              </Button>
              {isVideoModeAvailable() && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void enter(undefined, 'video')}
                >
                  {t('project.kindVideo')}
                </Button>
              )}
            </div>
          </div>
        )}
        {!search && recent && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void enter(undefined, 'image')}
            className="group flex min-h-48 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-muted/30 text-muted-foreground transition hover:border-primary/60 hover:bg-muted disabled:opacity-50"
          >
            <PlusIcon className="h-8 w-8 transition group-hover:text-primary" />
            <span className="text-sm font-medium">{t('grid.newProject')}</span>
          </button>
        )}
        {visible.map((project) => (
          <article
            key={project.id}
            className="group relative overflow-hidden rounded-2xl border border-border bg-card transition hover:border-primary/50"
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
                  <MediaImage
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
                <span className="absolute left-3 top-3 flex items-center gap-1.5">
                  <span className="rounded-full bg-background/85 px-2 py-1 text-[10px] text-muted-foreground">
                    {t(project.kind === 'video' ? 'project.kindVideo' : 'project.kindImage')}
                  </span>
                  {project.id === activeId && (
                    <span className="rounded-full bg-background/90 px-2 py-1 text-[10px] text-muted-foreground">
                      {t('grid.current')}
                    </span>
                  )}
                </span>
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
            </div>
            <Popover
              open={menuProjectId === project.id}
              onOpenChange={(open) => setMenuProjectId(open ? project.id : null)}
            >
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-2 top-2 rounded-xl bg-background/90 text-foreground shadow-sm hover:bg-background"
                  aria-label={t('grid.actionsAria', { name: projectDisplayName(project.name) })}
                >
                  <MoreHorizontal />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                collisionPadding={12}
                className="z-[600] w-56 rounded-xl p-1.5"
              >
                <Button
                  variant="ghost"
                  className="mt-1 w-full justify-start gap-3 px-3"
                  onClick={() => {
                    setMenuProjectId(null)
                    setRenaming(project)
                  }}
                >
                  <Pencil /> {t('grid.rename')}
                </Button>
                {!recent && (!project.cloud || project.cloud.revision > 0) && (
                  <Button
                    variant="ghost"
                    className="w-full justify-start gap-3 px-3 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => {
                      setMenuProjectId(null)
                      useStore.getState().setConfirmDialog({
                        title: t('grid.deleteTitle'),
                        message: t(project.cloud ? 'trash.deleteMessage' : 'grid.deleteMessage', {
                          name: projectDisplayName(project.name),
                        }),
                        action: () => {
                          void useAgentStore.getState().deleteProject(project.id)
                        },
                      })
                    }}
                  >
                    <TrashIcon className="h-4 w-4" /> {t('grid.deleteTitle')}
                  </Button>
                )}
              </PopoverContent>
            </Popover>
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

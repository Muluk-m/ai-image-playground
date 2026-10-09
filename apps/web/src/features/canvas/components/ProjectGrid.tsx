import { MessageCircle, MoreHorizontal, Pencil, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { TooltipIconButton } from '../../../components/assistant-ui/elements/tooltip-icon-button'
import { CanvasIcon, PlusIcon, TrashIcon, VideoIcon } from '../../../components/icons'
import { Button } from '../../../components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover'
import { useTranslation } from '../../../i18n'
import { formatDate } from '../../../i18n/format'
import { isVideoModeAvailable } from '../../../lib/channels/videoChannels'
import { useStore } from '../../../store'
import { useAgentStore } from '../../agent/store'
import NamingDialog from '../../library/components/NamingDialog'
import { useLibraryStore } from '../../library/store'
import { renameProject } from '../lib/activeProject'
import { projectCatalog, RECENT_PROJECT_COUNT } from '../lib/projectCatalog'
import { cloudProjectsEnabled } from '../lib/projectClient'
import {
  type CanvasProject,
  projectDisplayName,
  projectEntryName,
  projectExperience,
} from '../lib/projectRepository'
import { useCanvasProjectStore } from '../projectStore'
import ProjectCover from './ProjectCover'
import ProjectTrash from './ProjectTrash'

function projectBadge(project: CanvasProject) {
  if (projectExperience(project) === 'chat') {
    return {
      Icon: MessageCircle,
      label: 'grid.chat',
      tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
    } as const
  }
  if (project.kind === 'video') {
    return {
      Icon: VideoIcon,
      label: 'project.kindVideo',
      tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    } as const
  }
  return { Icon: CanvasIcon, label: 'grid.canvas', tone: 'bg-primary/15 text-primary' } as const
}

type ExperienceFilter = 'all' | 'chat' | 'canvas'
const FILTERS = [
  { value: 'all', label: 'grid.filterAll' },
  { value: 'canvas', label: 'grid.canvas' },
  { value: 'chat', label: 'grid.chat' },
] as const satisfies readonly { value: ExperienceFilter; label: string }[]

export default function ProjectGrid({
  search = '',
  recent = false,
  experience,
}: {
  search?: string
  recent?: boolean
  experience?: 'chat' | 'canvas'
}) {
  const { t } = useTranslation('canvas')
  const projects = useCanvasProjectStore((state) => state.projects)
  const activeId = useCanvasProjectStore((state) => state.activeId)
  const runningConversationId = useAgentStore((state) =>
    state.turn === 'running' ? state.conversationId : null,
  )
  const cloudError = useCanvasProjectStore((state) => state.cloudError)
  const cloudLoading = useCanvasProjectStore((state) => state.cloudLoading)
  const cloudCursor = useCanvasProjectStore((state) => state.cloudCursor)
  const cloudCatalog = useCanvasProjectStore((state) => state.cloudCatalog)
  const [trash, setTrash] = useState(false)
  const [renaming, setRenaming] = useState<CanvasProject | null>(null)
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<ExperienceFilter>('all')
  const showFilter = !recent && !experience
  const scoped = projectCatalog(projects, cloudCatalog).filter(
    (project) =>
      project.name.toLowerCase().includes(search.trim().toLowerCase()) &&
      (!recent || project.hasContent || project.workspaceOpened) &&
      (!experience || projectExperience(project) === experience),
  )
  const counts = {
    all: scoped.length,
    chat: scoped.filter((project) => projectExperience(project) === 'chat').length,
    canvas: 0,
  }
  counts.canvas = counts.all - counts.chat
  const visible = scoped
    .filter((project) => !showFilter || filter === 'all' || projectExperience(project) === filter)
    .slice(0, recent ? RECENT_PROJECT_COUNT : undefined)
  const enter = async (
    project?: CanvasProject,
    kind?: 'image' | 'video',
    entry: 'chat' | 'canvas' = 'canvas',
  ) => {
    if (busy) return
    setBusy(true)
    try {
      const opened = project
        ? await useAgentStore.getState().selectProject(project.id)
        : await useAgentStore.getState().createProject(kind, false, entry)
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
  const toolbarButton =
    'inline-flex h-8 items-center gap-1.5 rounded-full border border-border px-3 text-xs text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground disabled:opacity-50'
  return (
    <>
      {showFilter && (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <div
            role="radiogroup"
            aria-label={t('grid.filterAria')}
            className="mr-auto inline-flex rounded-xl bg-muted p-[3px]"
          >
            {FILTERS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={filter === value}
                onClick={() => setFilter(value)}
                className={`inline-flex h-7 items-center gap-1 rounded-lg px-3 text-xs transition-colors ${
                  filter === value
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {t(label)}
                <span className="tabular-nums opacity-60">{counts[value]}</span>
              </button>
            ))}
          </div>
          {cloudProjectsEnabled() && (
            <>
              {cloudError && (
                <span role="alert" className="text-xs text-muted-foreground">
                  {cloudError}
                </span>
              )}
              <button
                type="button"
                disabled={cloudLoading}
                onClick={() => void useCanvasProjectStore.getState().refreshCloud()}
                className={toolbarButton}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${cloudLoading ? 'animate-spin' : ''}`} />
                {cloudLoading
                  ? t('grid.loadingCloud')
                  : cloudError
                    ? t('grid.retryCloud')
                    : t('grid.refreshCloud')}
              </button>
              <button type="button" onClick={() => setTrash(true)} className={toolbarButton}>
                <TrashIcon className="h-3.5 w-3.5" />
                {t('trash.title')}
              </button>
            </>
          )}
        </div>
      )}
      <div className="grid grid-cols-1 gap-x-5 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {!search && !recent && (
          <div className="flex aspect-[4/3] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border text-muted-foreground">
            <PlusIcon className="h-7 w-7" />
            <span className="text-sm font-medium">{t('grid.newProject')}</span>
            {/* 画布类型建后不可改，所以在这里问一次，而不是进去再切。 */}
            <div className="flex flex-wrap justify-center gap-2">
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
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void enter(undefined, undefined, 'chat')}
              >
                {t('grid.chat')}
              </Button>
            </div>
          </div>
        )}
        {visible.map((project) => {
          const { Icon: TypeIcon, label, tone } = projectBadge(project)
          const typeLabel = t(label)
          const isCurrent = project.id === activeId
          const statusLabel = [typeLabel, ...(isCurrent ? [t('grid.current')] : [])].join(' · ')
          return (
            <article key={project.id} className="group relative">
              <button
                type="button"
                disabled={busy}
                aria-label={`${t('grid.openAria', { name: projectEntryName(project) })} · ${statusLabel}`}
                onClick={() => void enter(project)}
                className="block w-full rounded-2xl text-left disabled:opacity-50"
              >
                <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-2xl border border-border bg-muted transition-colors group-hover:border-primary/50">
                  <ProjectCover
                    source={project.cover}
                    chat={projectExperience(project) === 'chat'}
                    pending={
                      cloudLoading ||
                      (Boolean(project.conversationId) &&
                        project.conversationId === runningConversationId)
                    }
                  />
                </div>
                <div className="mt-2.5 flex items-center gap-2 pr-1">
                  <span
                    className={`inline-flex h-[22px] flex-none items-center gap-1 rounded-md px-1.5 text-xs font-medium ${tone}`}
                  >
                    <TypeIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    {typeLabel}
                  </span>
                  {isCurrent && (
                    <span
                      role="img"
                      aria-label={t('grid.current')}
                      title={t('grid.current')}
                      className="h-2 w-2 flex-none rounded-full bg-primary ring-[3px] ring-primary/25"
                    />
                  )}
                  <h3
                    className="min-w-0 truncate text-sm font-medium text-foreground"
                    title={projectEntryName(project)}
                  >
                    {projectEntryName(project)}
                  </h3>
                </div>
              </button>
              <time
                className="mt-1 block truncate px-0.5 text-xs text-muted-foreground"
                dateTime={new Date(project.updatedAt).toISOString()}
              >
                {t('grid.updatedAt', { date: formatDate(project.updatedAt) })}
              </time>
              <Popover
                open={menuProjectId === project.id}
                onOpenChange={(open) => setMenuProjectId(open ? project.id : null)}
              >
                <PopoverTrigger asChild>
                  <TooltipIconButton
                    className="absolute right-2 top-2 size-9 rounded-xl bg-background/90 text-foreground opacity-0 shadow-sm transition-opacity hover:bg-background focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
                    aria-label={t('grid.actionsAria', { name: projectEntryName(project) })}
                    tooltip={t('grid.actions')}
                  >
                    <MoreHorizontal />
                  </TooltipIconButton>
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
                            name: projectEntryName(project),
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
          )
        })}
      </div>
      {showFilter && cloudProjectsEnabled() && cloudCursor && (
        <div className="mt-8 flex justify-center">
          <button
            type="button"
            disabled={cloudLoading}
            onClick={() => void useCanvasProjectStore.getState().refreshCloud(true)}
            className={toolbarButton}
          >
            {t('grid.loadMore')}
          </button>
        </div>
      )}
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
            void renameProject(renaming.id, name).then(
              () => setRenaming(null),
              () => useStore.getState().showToast(t('grid.renameFailed'), 'error'),
            )
          }}
        />
      )}
    </>
  )
}

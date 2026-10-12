import { useState } from 'react'
import { TooltipIconButton } from '../../../components/assistant-ui/elements/tooltip-icon-button'
import SegmentedTabs from '../../../components/patterns/SegmentedTabs'
import { Button } from '../../../components/ui/button'
import { Icon, type IconName } from '../../../components/ui/icon'
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover'
import { useTranslation } from '../../../i18n'
import { formatDate } from '../../../i18n/format'
import { isVideoModeAvailable } from '../../../lib/channels/videoChannels'
import { useStore } from '../../../store'
import { useAgentStore } from '../../agent/store'
import NamingDialog from '../../library/components/NamingDialog'
import { useLibraryStore } from '../../library/store'
import { renameProject } from '../lib/activeProject'
import { catalogProjectId, projectCatalog, RECENT_PROJECT_COUNT } from '../lib/projectCatalog'
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

function projectBadge(project: CanvasProject): {
  icon: IconName
  label: 'grid.chat' | 'project.kindVideo' | 'grid.canvas'
  tone: string
} {
  if (projectExperience(project) === 'chat') {
    return {
      icon: 'chat',
      label: 'grid.chat',
      tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
    }
  }
  if (project.kind === 'video') {
    return {
      icon: 'video',
      label: 'project.kindVideo',
      tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    }
  }
  return { icon: 'canvas', label: 'grid.canvas', tone: 'bg-primary/15 text-primary' }
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
  const selectedId = catalogProjectId(
    projects.find((project) => project.id === activeId),
    projects,
  )
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
  return (
    <>
      {showFilter && (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <div className="mr-auto">
            <SegmentedTabs
              label={t('grid.filterAria')}
              value={filter}
              onChange={setFilter}
              tabs={FILTERS.map(({ value, label }) => ({
                value,
                label: (
                  <span className="inline-flex items-center gap-1">
                    {t(label)}
                    <span className="tabular-nums text-muted-foreground">{counts[value]}</span>
                  </span>
                ),
              }))}
            />
          </div>
          {cloudProjectsEnabled() && (
            <>
              {cloudError && (
                <span role="alert" className="text-xs text-muted-foreground">
                  {cloudError}
                </span>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={cloudLoading}
                onClick={() => void useCanvasProjectStore.getState().refreshCloud()}
              >
                <Icon name="refresh" className={cloudLoading ? 'animate-spin' : undefined} />
                {cloudLoading
                  ? t('grid.loadingCloud')
                  : cloudError
                    ? t('grid.retryCloud')
                    : t('grid.refreshCloud')}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setTrash(true)}>
                <Icon name="delete" />
                {t('trash.title')}
              </Button>
            </>
          )}
        </div>
      )}
      <div className="grid grid-cols-1 gap-x-5 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {!search && !recent && (
          <div className="flex aspect-[4/3] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border text-muted-foreground">
            <Icon name="add" size="lg" />
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
          const { icon, label, tone } = projectBadge(project)
          const typeLabel = t(label)
          const isCurrent = project.id === selectedId
          const statusLabel = [typeLabel, ...(isCurrent ? [t('grid.current')] : [])].join(' · ')
          return (
            <article key={project.id} className="group relative">
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                aria-label={`${t('grid.openAria', { name: projectEntryName(project) })} · ${statusLabel}`}
                onClick={() => void enter(project)}
                className="block h-auto w-full whitespace-normal rounded-2xl p-0 text-left font-normal hover:bg-transparent disabled:opacity-50"
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
                    <Icon name={icon} size="xs" />
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
              </Button>
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
                    <Icon name="more" />
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
                    <Icon name="edit" /> {t('grid.rename')}
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
                      <Icon name="delete" /> {t('grid.deleteTitle')}
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={cloudLoading}
            onClick={() => void useCanvasProjectStore.getState().refreshCloud(true)}
          >
            {t('grid.loadMore')}
          </Button>
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

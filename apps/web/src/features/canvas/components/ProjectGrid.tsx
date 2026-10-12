import { useState } from 'react'
import { TooltipIconButton } from '../../../components/assistant-ui/elements/tooltip-icon-button'
import { ProjectCardSurface } from '../../../components/creation/MediaGallery'
import '../../../components/creation/creation.css'
import SegmentedTabs from '../../../components/patterns/SegmentedTabs'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
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
  label: 'grid.chat' | 'project.kindVideo' | 'grid.canvas'
} {
  return {
    label:
      projectExperience(project) === 'chat'
        ? 'grid.chat'
        : project.kind === 'video'
          ? 'project.kindVideo'
          : 'grid.canvas',
  }
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
          <div className="flex aspect-video flex-col items-center justify-center gap-3 rounded-xl border border-border bg-muted/50 text-muted-foreground">
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
          const { label } = projectBadge(project)
          const typeLabel = t(label)
          const isCurrent = project.id === selectedId
          const statusLabel = [typeLabel, ...(isCurrent ? [t('grid.current')] : [])].join(' · ')
          return (
            <ProjectCardSurface
              key={project.id}
              name={projectEntryName(project)}
              date={
                <time dateTime={new Date(project.updatedAt).toISOString()}>
                  {t('grid.updatedAt', { date: formatDate(project.updatedAt) })}
                </time>
              }
              onOpen={() => void enter(project)}
              disabled={busy}
              label={`${t('grid.openAria', { name: projectEntryName(project) })} · ${statusLabel}`}
              cover={
                <>
                  <ProjectCover
                    fit="cover"
                    source={project.cover}
                    chat={projectExperience(project) === 'chat'}
                    pending={
                      cloudLoading ||
                      (Boolean(project.conversationId) &&
                        project.conversationId === runningConversationId)
                    }
                  />
                  {project.kind === 'video' && (
                    <span className="creation-play-badge">
                      <Icon name="play" />
                    </span>
                  )}
                </>
              }
              menu={
                <Popover
                  open={menuProjectId === project.id}
                  onOpenChange={(open) => setMenuProjectId(open ? project.id : null)}
                >
                  <PopoverTrigger asChild>
                    <TooltipIconButton
                      className="creation-project-menu"
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
                            message: t(
                              project.cloud ? 'trash.deleteMessage' : 'grid.deleteMessage',
                              {
                                name: projectEntryName(project),
                              },
                            ),
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
              }
            />
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

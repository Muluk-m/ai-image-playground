import {
  Check,
  ChevronDown,
  FolderOpen,
  LayoutDashboard,
  LoaderCircle,
  MessageCircle,
  Plus,
} from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useAgentStore } from '../features/agent/store'
import { renameProject } from '../features/canvas/lib/activeProject'
import {
  projectCatalog,
  projectsByExperience,
  RECENT_PROJECT_COUNT,
} from '../features/canvas/lib/projectCatalog'
import {
  projectDisplayName,
  projectEntryName,
  projectExperience,
  UNTITLED_PROJECT,
} from '../features/canvas/lib/projectRepository'
import { useCanvasProjectStore } from '../features/canvas/projectStore'
import { useLibraryStore } from '../features/library/store'
import { useTranslation } from '../i18n'
import { useStore } from '../store'
import MediaImage from './MediaImage'
import SearchField from './SearchField'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from './ui/popover'

const INITIAL_VISIBLE = { chat: RECENT_PROJECT_COUNT, canvas: RECENT_PROJECT_COUNT }

const rowClass =
  'flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-60'

const footerIcon = 'grid h-8 w-10 shrink-0 place-items-center text-muted-foreground'

/** 项目胶囊：`leading`（品牌 logo）| 项目名（点击改名）| 展开按钮。 */
export default function ProjectNavigation({ leading }: { leading?: ReactNode }) {
  const { t } = useTranslation(['agent', 'canvas'])
  const projects = useCanvasProjectStore((state) => state.projects)
  const activeId = useCanvasProjectStore((state) => state.activeId)
  const cloudCatalog = useCanvasProjectStore((state) => state.cloudCatalog)
  const cloudLoading = useCanvasProjectStore((state) => state.cloudLoading)
  const cloudError = useCanvasProjectStore((state) => state.cloudError)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(false)
  const [visibleCounts, setVisibleCounts] = useState(INITIAL_VISIBLE)
  // 切项目要落盘旧画布再取云端那份，网络慢时是秒级的等待，只置灰的话点下去像没反应。
  const [pending, setPending] = useState<string | 'new' | null>(null)
  const busy = pending !== null
  const catalog = useMemo(() => projectCatalog(projects, cloudCatalog), [projects, cloudCatalog])
  const current = catalog.find((project) => project.id === activeId)
  const name = current
    ? projectEntryName(current)
    : projectDisplayName(
        projects.find((project) => project.id === activeId)?.name ?? UNTITLED_PROJECT,
      )
  const query = search.trim().toLocaleLowerCase()
  const recent = current
    ? [current, ...catalog.filter((project) => project.id !== activeId)]
    : catalog
  const matches = (query ? catalog : recent).filter((project) =>
    projectEntryName(project).toLocaleLowerCase().includes(query),
  )
  const currentExperience = current ? projectExperience(current) : 'chat'
  const groupOrder: ('chat' | 'canvas')[] =
    currentExperience === 'canvas' ? ['canvas', 'chat'] : ['chat', 'canvas']
  const matchesByExperience = projectsByExperience(matches)
  const groups = groupOrder.map((experience) => {
    const items = matchesByExperience[experience]
    return { experience, items, visible: items.slice(0, visibleCounts[experience]) }
  })
  const allProjects = () => {
    setOpen(false)
    useLibraryStore.getState().openProjects()
  }
  const enter = async (id?: string, experience: 'chat' | 'canvas' = 'chat') => {
    if (busy) return
    if (id === activeId) {
      setOpen(false)
      return
    }
    setPending(id ?? 'new')
    try {
      const opened = id
        ? await useAgentStore.getState().selectProject(id)
        : await useAgentStore.getState().createProject(undefined, false, experience)
      if (opened) setOpen(false)
    } finally {
      setPending(null)
    }
  }
  const commitName = (value: string) => {
    setEditing(false)
    const next = value.trim()
    if (!activeId || !next || next === name) return
    void renameProject(activeId, next).catch(() =>
      useStore.getState().showToast(t('canvas:grid.renameFailed'), 'error'),
    )
  }

  return (
    <div className="studio-agent-project shrink-0">
      <Popover
        open={open}
        onOpenChange={(value) => {
          setOpen(value)
          if (value) {
            setSearch('')
            setVisibleCounts(INITIAL_VISIBLE)
            void useCanvasProjectStore.getState().refreshCloud()
          }
        }}
      >
        <PopoverAnchor asChild>
          <div className="studio-project-pill">
            {leading && (
              <>
                {leading}
                <span aria-hidden="true" className="studio-project-pill-divider" />
              </>
            )}
            {editing ? (
              <input
                autoFocus
                defaultValue={name}
                aria-label={t('navigation.renameAria')}
                maxLength={80}
                className="studio-project-pill-name studio-project-pill-input"
                onFocus={(event) => event.currentTarget.select()}
                onBlur={(event) => commitName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return
                  if (event.key === 'Enter') event.currentTarget.blur()
                  if (event.key === 'Escape') {
                    event.currentTarget.value = name
                    event.currentTarget.blur()
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="studio-project-pill-name"
                title={t('navigation.renameHint')}
                aria-label={t('navigation.renameAria')}
                disabled={!activeId}
                onClick={() => setEditing(true)}
              >
                <span className="truncate">{name}</span>
              </button>
            )}
            <PopoverTrigger asChild>
              <button
                type="button"
                className="studio-project-pill-toggle"
                aria-label={t('navigation.switchAria', { name })}
                title={t('navigation.switchTitle')}
                disabled={busy}
              >
                {busy ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <ChevronDown className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </PopoverTrigger>
          </div>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          sideOffset={6}
          collisionPadding={12}
          aria-label={t('navigation.switchTitle')}
          className="z-[600] flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-80 max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-2xl p-2 shadow-popover"
        >
          <SearchField
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setVisibleCounts(INITIAL_VISIBLE)
            }}
            placeholder={t('navigation.search')}
            aria-label={t('navigation.search')}
            className="h-10 max-w-none shrink-0 rounded-xl border-transparent bg-muted focus-within:border-foreground/15 focus-within:ring-0"
          />
          <div className="mt-1 min-h-0 overflow-y-auto" aria-busy={busy}>
            {groups
              .filter((group) => group.items.length > 0)
              .map((group) => (
                <section
                  key={group.experience}
                  aria-label={t(
                    group.experience === 'chat' ? 'navigation.chats' : 'navigation.canvases',
                  )}
                >
                  <p className="px-2 pb-1 pt-2 text-label-sm text-muted-foreground">
                    {t(group.experience === 'chat' ? 'navigation.chats' : 'navigation.canvases')}
                  </p>
                  {group.visible.map((project) => {
                    const active = project.id === activeId
                    return (
                      <button
                        key={project.id}
                        type="button"
                        data-project-row=""
                        disabled={busy}
                        onClick={() => void enter(project.id)}
                        aria-current={active ? 'true' : undefined}
                        className={`${rowClass} ${active ? 'bg-accent' : ''}`}
                      >
                        {/* 云端封面是要换签名 URL 的 `aip-media:` 引用，交给 MediaImage；取不到就露出底下的图标。 */}
                        <span className="relative grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
                          {projectExperience(project) === 'chat' ? (
                            <MessageCircle className="h-4 w-4" aria-hidden="true" />
                          ) : (
                            <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
                          )}
                          {project.cover && (
                            <MediaImage
                              src={project.cover}
                              alt=""
                              loading="lazy"
                              className="absolute inset-0 h-full w-full object-cover"
                            />
                          )}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{projectEntryName(project)}</span>
                        {project.id === pending ? (
                          <LoaderCircle
                            className="h-4 w-4 shrink-0 animate-spin text-muted-foreground"
                            aria-hidden="true"
                          />
                        ) : (
                          active && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                        )}
                      </button>
                    )
                  })}
                  {group.items.length > RECENT_PROJECT_COUNT && (
                    <div className="flex items-center gap-1 px-1">
                      {group.visible.length < group.items.length && (
                        <button
                          type="button"
                          className="rounded-lg px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                          onClick={() =>
                            setVisibleCounts((value) => ({
                              ...value,
                              [group.experience]: value[group.experience] + RECENT_PROJECT_COUNT,
                            }))
                          }
                        >
                          {t('navigation.expand', {
                            remaining: Math.min(
                              RECENT_PROJECT_COUNT,
                              group.items.length - group.visible.length,
                            ),
                          })}
                        </button>
                      )}
                      {visibleCounts[group.experience] > RECENT_PROJECT_COUNT && (
                        <button
                          type="button"
                          className="rounded-lg px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                          onClick={() =>
                            setVisibleCounts((value) => ({
                              ...value,
                              [group.experience]: RECENT_PROJECT_COUNT,
                            }))
                          }
                        >
                          {t('navigation.collapse')}
                        </button>
                      )}
                    </div>
                  )}
                </section>
              ))}
            {!matches.length && (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {t('canvas:grid.noMatch')}
              </p>
            )}
            {cloudLoading && (
              <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
                {t('canvas:grid.loadingCloud')}
              </p>
            )}
            {cloudError && (
              <div role="alert" className="px-3 py-2 text-xs text-muted-foreground">
                {cloudError}{' '}
                <button
                  type="button"
                  className="text-foreground underline-offset-2 hover:underline"
                  disabled={cloudLoading}
                  onClick={() => void useCanvasProjectStore.getState().refreshCloud()}
                >
                  {t('canvas:grid.retryCloud')}
                </button>
              </div>
            )}
          </div>
          <div className="mt-1 shrink-0 border-t border-border pt-1">
            <button
              type="button"
              className={rowClass}
              disabled={busy}
              onClick={() => void enter(undefined, 'chat')}
            >
              <span className={footerIcon}>
                {pending === 'new' ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Plus className="h-4 w-4" aria-hidden="true" />
                )}
              </span>
              {t('navigation.newChat')}
            </button>
            <button
              type="button"
              className={rowClass}
              disabled={busy}
              onClick={() => void enter(undefined, 'canvas')}
            >
              <span className={footerIcon}>
                <Plus className="h-4 w-4" aria-hidden="true" />
              </span>
              {t('navigation.newCanvas')}
            </button>
            <button type="button" className={rowClass} disabled={busy} onClick={allProjects}>
              <span className={footerIcon}>
                <FolderOpen className="h-4 w-4" aria-hidden="true" />
              </span>
              {t('navigation.all')}
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

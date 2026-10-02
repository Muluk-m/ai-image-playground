import {
  Check,
  ChevronDown,
  FolderOpen,
  LayoutDashboard,
  LoaderCircle,
  MessageCircle,
  Plus,
  Search,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useAgentStore } from '../features/agent/store'
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
import { formatDateMinute } from '../i18n/format'
import { useStore } from '../store'
import MediaImage from './MediaImage'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

const INITIAL_VISIBLE = { chat: RECENT_PROJECT_COUNT, canvas: RECENT_PROJECT_COUNT }

export default function ProjectNavigation() {
  const { t } = useTranslation(['agent', 'canvas'])
  const projects = useCanvasProjectStore((state) => state.projects)
  const activeId = useCanvasProjectStore((state) => state.activeId)
  const cloudCatalog = useCanvasProjectStore((state) => state.cloudCatalog)
  const cloudLoading = useCanvasProjectStore((state) => state.cloudLoading)
  const cloudError = useCanvasProjectStore((state) => state.cloudError)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [visibleCounts, setVisibleCounts] = useState(INITIAL_VISIBLE)
  // 哪一项正在打开。切项目要落盘旧画布再取云端那份，网络慢时是秒级的等待，
  // 只把按钮置灰的话点下去像没反应。`'new'` 是「新建」那一项。
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

  return (
    <div className="studio-agent-project shrink-0 border-b border-border px-3 py-3">
      <div className="flex min-w-0 items-center gap-1">
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
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              className="min-w-0 max-w-[15rem] flex-1 justify-between gap-2 px-2 text-left"
              title={name}
              aria-label={t('navigation.switchAria', { name })}
              disabled={busy}
            >
              <span className="truncate" title={name}>
                {name}
              </span>
              <ChevronDown className="text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            collisionPadding={12}
            aria-label={t('navigation.switchTitle')}
            className="z-[600] flex max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl p-2"
          >
            <div className="relative m-1">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value)
                  setVisibleCounts(INITIAL_VISIBLE)
                }}
                placeholder={t('navigation.search')}
                aria-label={t('navigation.search')}
                className="pl-9 text-xs"
              />
            </div>
            <p className="px-3 pb-1 pt-3 text-label-sm text-muted-foreground">
              {query ? t('navigation.results') : t('navigation.recent')}
            </p>
            <div className="min-h-0 overflow-y-auto" aria-busy={busy}>
              {groups
                .filter((group) => group.items.length > 0)
                .map((group) => (
                  <section
                    key={group.experience}
                    aria-label={t(
                      group.experience === 'chat' ? 'navigation.chats' : 'navigation.canvases',
                    )}
                  >
                    <p className="px-3 pb-1 pt-3 text-label-sm text-muted-foreground">
                      {t(group.experience === 'chat' ? 'navigation.chats' : 'navigation.canvases')}
                    </p>
                    {group.visible.map((project) => (
                      <Button
                        key={project.id}
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void enter(project.id)}
                        aria-current={project.id === activeId ? 'true' : undefined}
                        className={`h-auto min-h-14 w-full justify-start gap-3 px-3 py-2 text-left ${project.id === activeId ? 'bg-accent' : ''}`}
                      >
                        {/* 云端项目的封面是 `aip-media:` 这种要换签名 URL 的引用，交给 MediaImage；
                      本机项目的封面是 data URL，同一条路直出。取不到封面就露出底下的文件夹图标，
                      不把认不出的地址塞进 <img>——那只会得到一个碎图。 */}
                        <span className="relative flex h-10 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground">
                          {projectExperience(project) === 'chat' ? (
                            <MessageCircle aria-hidden="true" />
                          ) : (
                            <LayoutDashboard aria-hidden="true" />
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
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs">
                            {projectEntryName(project)}
                          </span>
                          <time
                            dateTime={new Date(project.updatedAt).toISOString()}
                            className="mt-0.5 block text-label-sm font-normal text-muted-foreground"
                          >
                            {formatDateMinute(project.updatedAt)}
                          </time>
                        </span>
                        {project.id === pending ? (
                          <LoaderCircle className="animate-spin text-primary" aria-hidden="true" />
                        ) : (
                          project.id === activeId && <Check className="text-primary" />
                        )}
                      </Button>
                    ))}
                    {group.items.length > RECENT_PROJECT_COUNT && (
                      <div className="flex items-center">
                        {group.visible.length < group.items.length && (
                          <Button
                            variant="ghost"
                            className="justify-start px-3 text-xs text-muted-foreground"
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
                          </Button>
                        )}
                        {visibleCounts[group.experience] > RECENT_PROJECT_COUNT && (
                          <Button
                            variant="ghost"
                            className="justify-start px-3 text-xs text-muted-foreground"
                            onClick={() =>
                              setVisibleCounts((value) => ({
                                ...value,
                                [group.experience]: RECENT_PROJECT_COUNT,
                              }))
                            }
                          >
                            {t('navigation.collapse')}
                          </Button>
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
                  <Button
                    variant="link"
                    size="sm"
                    disabled={cloudLoading}
                    onClick={() => void useCanvasProjectStore.getState().refreshCloud()}
                  >
                    {t('canvas:grid.retryCloud')}
                  </Button>
                </div>
              )}
            </div>
            <div className="mt-2 shrink-0 border-t border-border pt-2">
              <Button
                variant="ghost"
                className="h-auto w-full justify-start px-3 py-2 text-primary"
                disabled={busy}
                onClick={() => void enter(undefined, 'chat')}
              >
                {pending === 'new' ? <LoaderCircle className="animate-spin" /> : <MessageCircle />}
                <span className="text-left text-xs">
                  {t('navigation.newChat')}
                  <span className="mt-0.5 block text-label-sm font-normal text-muted-foreground">
                    {t('navigation.newChatHint')}
                  </span>
                </span>
              </Button>
              <Button
                variant="ghost"
                className="h-auto w-full justify-start px-3 py-2"
                disabled={busy}
                onClick={() => void enter(undefined, 'canvas')}
              >
                <LayoutDashboard />
                <span className="text-left text-xs">
                  {t('navigation.newCanvas')}
                  <span className="mt-0.5 block text-label-sm font-normal text-muted-foreground">
                    {t('navigation.newCanvasHint')}
                  </span>
                </span>
              </Button>
              <Button
                variant="ghost"
                className="w-full justify-start px-3 text-xs"
                disabled={busy}
                onClick={allProjects}
              >
                <FolderOpen /> {t('navigation.all')}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 text-muted-foreground"
          aria-label={t('panel.newProjectAria')}
          title={t('navigation.newHint')}
          disabled={busy}
          onClick={() => void enter(undefined, 'chat')}
        >
          {pending === 'new' ? <LoaderCircle className="animate-spin" /> : <Plus />}
        </Button>
      </div>
    </div>
  )
}

import { ArrowLeft, Check, ChevronDown, FolderOpen, LoaderCircle, Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useAgentStore } from '../features/agent/store'
import { projectCatalog } from '../features/canvas/lib/projectCatalog'
import { projectDisplayName, UNTITLED_PROJECT } from '../features/canvas/lib/projectRepository'
import { useCanvasProjectStore } from '../features/canvas/projectStore'
import { useLibraryStore } from '../features/library/store'
import { useTranslation } from '../i18n'
import { formatDateMinute } from '../i18n/format'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

export default function ProjectNavigation() {
  const { t } = useTranslation(['agent', 'canvas'])
  const projects = useCanvasProjectStore((state) => state.projects)
  const activeId = useCanvasProjectStore((state) => state.activeId)
  const cloudCatalog = useCanvasProjectStore((state) => state.cloudCatalog)
  const cloudLoading = useCanvasProjectStore((state) => state.cloudLoading)
  const cloudError = useCanvasProjectStore((state) => state.cloudError)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const catalog = useMemo(() => projectCatalog(projects, cloudCatalog), [projects, cloudCatalog])
  const current = catalog.find((project) => project.id === activeId)
  const name = projectDisplayName(current?.name ?? UNTITLED_PROJECT)
  const query = search.trim().toLocaleLowerCase()
  const recent = current
    ? [current, ...catalog.filter((project) => project.id !== activeId)]
    : catalog
  const visible = (query ? catalog : recent)
    .filter((project) => projectDisplayName(project.name).toLocaleLowerCase().includes(query))
    .slice(0, query ? 30 : 8)
  const allProjects = () => {
    setOpen(false)
    useLibraryStore.getState().openPanel('projects')
  }
  const enter = async (id?: string) => {
    if (busy) return
    if (id === activeId) {
      setOpen(false)
      return
    }
    setBusy(true)
    try {
      const opened = id
        ? await useAgentStore.getState().selectProject(id)
        : await useAgentStore.getState().createProject()
      if (opened) setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="studio-agent-project shrink-0 border-b border-border px-3 py-3">
      <div className="flex min-w-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 text-muted-foreground"
          aria-label={t('navigation.back')}
          title={t('navigation.back')}
          disabled={busy}
          onClick={allProjects}
        >
          <ArrowLeft />
        </Button>
        <Popover
          open={open}
          onOpenChange={(value) => {
            setOpen(value)
            if (value) {
              setSearch('')
              void useCanvasProjectStore.getState().refreshCloud()
            }
          }}
        >
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              className="min-w-0 flex-1 justify-between gap-2 px-2 text-left"
              title={name}
              aria-label={t('navigation.switchAria', { name })}
              disabled={busy}
            >
              <span className="truncate">{name}</span>
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
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('navigation.search')}
                aria-label={t('navigation.search')}
                className="pl-9 text-xs"
              />
            </div>
            <p className="px-3 pb-1 pt-3 text-[11px] text-muted-foreground">
              {query ? t('navigation.results') : t('navigation.recent')}
            </p>
            <div className="min-h-0 overflow-y-auto" aria-busy={busy}>
              {visible.map((project) => (
                <Button
                  key={project.id}
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void enter(project.id)}
                  aria-current={project.id === activeId ? 'true' : undefined}
                  className={`h-auto min-h-14 w-full justify-start gap-3 px-3 py-2 text-left ${project.id === activeId ? 'bg-accent' : ''}`}
                >
                  <span className="flex h-10 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground">
                    {project.cover ? (
                      <img src={project.cover} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <FolderOpen />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs">
                      {projectDisplayName(project.name)}
                    </span>
                    <time
                      dateTime={new Date(project.updatedAt).toISOString()}
                      className="mt-0.5 block text-[10px] font-normal text-muted-foreground"
                    >
                      {formatDateMinute(project.updatedAt)}
                    </time>
                  </span>
                  {project.id === activeId && <Check className="text-primary" />}
                </Button>
              ))}
              {!visible.length && (
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
                onClick={() => void enter()}
              >
                <Plus />
                <span className="text-left text-xs">
                  {t('panel.newProjectAria')}
                  <span className="mt-0.5 block text-[10px] font-normal text-muted-foreground">
                    {t('navigation.newHint')}
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
          onClick={() => void enter()}
        >
          {busy ? <LoaderCircle className="animate-spin" /> : <Plus />}
        </Button>
      </div>
    </div>
  )
}

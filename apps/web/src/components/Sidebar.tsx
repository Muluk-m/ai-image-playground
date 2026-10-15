import { useEffect, useState } from 'react'
import { useAgentStore } from '../features/agent/store'
import {
  catalogProjectId,
  projectCatalog,
  projectsByExperience,
  RECENT_PROJECT_COUNT,
} from '../features/canvas/lib/projectCatalog'
import {
  type CanvasProject,
  projectEntryName,
  projectExperience,
} from '../features/canvas/lib/projectRepository'
import { useCanvasProjectStore } from '../features/canvas/projectStore'
import { GUIDE_PATHS } from '../features/guide/paths'
import { useLibraryStore } from '../features/library/store'
import { currentLocale, useTranslation } from '../i18n'

import {
  APP_MODE_LABELS,
  type AppMode,
  defaultSidebarExpanded,
  NAV_APP_MODES,
  useStore,
} from '../store'
import { useTheme } from '../theme/useTheme'
import MediaImage from './MediaImage'
import { Button } from './ui/button'
import { Icon, type IconName } from './ui/icon'

/** 侧栏里每个入口的图标；标签与顺序由 `NAV_APP_MODES` 与语料决定。 */
const MODE_ICONS: Record<AppMode, IconName> = {
  image: 'create',
  canvas: 'canvas',
  explore: 'explore',
  library: 'assets',
  tools: 'toolbox',
}

const ITEM = 'h-9 w-full justify-start gap-2.5 px-3 text-body-sm font-normal'
/** 主入口选中用芽绿浅底，图文沿用 primary，亮暗主题共用。 */
const ACTIVE_ITEM = 'bg-primary/15 font-medium text-primary hover:bg-primary/15 hover:text-primary'
const IDLE_ITEM = 'text-muted-foreground hover:bg-muted hover:text-foreground'
const ACTIVE_ROW = 'bg-accent font-medium text-foreground'
const SIDEBAR_WIDTH = '264px'
const SIDEBAR_RAIL_WIDTH = '64px'

/**
 * 主导航。品牌在侧栏里，账号与积分在内容面板顶上对齐成一组。
 * 宽屏展开 264px，资产页收起后保留 64px 图标轨；窄屏塌成底部标签条。
 */
export default function Sidebar() {
  const { t } = useTranslation('shell')
  const { theme } = useTheme()
  const appMode = useStore((state) => state.appMode)
  const setAppMode = useStore((state) => state.setAppMode)
  const projects = useCanvasProjectStore((state) => state.projects)
  const cloudCatalog = useCanvasProjectStore((state) => state.cloudCatalog)
  const activeId = useCanvasProjectStore((state) => state.activeId)
  // 对话和画布都留着这条宽栏。用户收起，或从列表里沉浸式打开时，才铺满。
  // 别处默认摊开；用户在当前入口手动开合过，就以他的选择为准。
  const activeProject = projects.find((project) => project.id === activeId)
  const sidebarPreference = useStore((state) => state.sidebarExpanded)
  const expanded =
    sidebarPreference ??
    defaultSidebarExpanded(appMode, activeProject ? projectExperience(activeProject) : null)
  const showRail = !expanded && appMode === 'library'
  const toggleSidebar = () => useStore.setState({ sidebarExpanded: !expanded })
  // 目录只在画布挂载时加载过；侧栏在别的入口也要列项目，所以自己也拉一次（重复调用是幂等的）。
  useEffect(() => {
    void useCanvasProjectStore.getState().load()
  }, [])
  // 主区与页头一起让位；资产保留图标轨，画布沉浸模式仍铺满。
  useEffect(() => {
    document.documentElement.dataset.sidebar = expanded ? 'open' : 'collapsed'
    document.documentElement.style.setProperty(
      '--app-sidebar-size',
      expanded ? SIDEBAR_WIDTH : showRail ? SIDEBAR_RAIL_WIDTH : '0px',
    )
    document.documentElement.style.setProperty(
      '--app-nav-toggle-space',
      expanded || showRail ? '0px' : '4rem',
    )
    return () => {
      delete document.documentElement.dataset.sidebar
    }
  }, [expanded, showRail])
  const catalog = projectCatalog(projects, cloudCatalog)
  const selectedId = catalogProjectId(activeProject, catalog)
  const recent = catalog.filter((project) => project.hasContent || project.workspaceOpened)
  const grouped = projectsByExperience(recent)
  const chats = grouped.chat.slice(0, RECENT_PROJECT_COUNT)
  const canvases = grouped.canvas.slice(0, RECENT_PROJECT_COUNT)

  // 正在打开的那个项目。切项目要落盘旧画布再取云端那份，网络慢时是秒级的等待，
  // 这一行不给反馈的话点下去像没反应。
  const [opening, setOpening] = useState<string | null>(null)
  const openProject = async (id: string, immersive = false) => {
    if (opening) return
    setOpening(id)
    try {
      if (!(await useAgentStore.getState().selectProject(id))) return
    } finally {
      setOpening(null)
    }
    setAppMode('canvas')
    // 沉浸式打开：进画布顺手把侧栏收掉。必须排在 setAppMode 后面——它会把这个选择复位成
    // 「按入口默认」。
    if (immersive) useStore.setState({ sidebarExpanded: false })
  }

  const openProjects = useLibraryStore((s) => s.openProjects)
  const newProject = async (experience: 'chat' | 'canvas') => {
    if (!(await useAgentStore.getState().createProject(undefined, false, experience))) return
    setAppMode('canvas')
  }

  const item = (mode: AppMode) => {
    const active = appMode === mode || (mode === 'image' && appMode === 'canvas')
    return (
      <Button
        key={mode}
        type="button"
        variant="ghost"
        onClick={() => setAppMode(mode)}
        aria-pressed={active}
        aria-label={APP_MODE_LABELS[mode]}
        autoTooltip={false}
        className={`${showRail ? 'size-10 shrink-0 rounded-xl p-0 [&_svg]:size-5' : ITEM} ${active ? ACTIVE_ITEM : IDLE_ITEM}`}
      >
        <Icon name={MODE_ICONS[mode]} filled={active} />
        {!showRail && APP_MODE_LABELS[mode]}
      </Button>
    )
  }

  const wordmark =
    theme === 'light' ? '/brand/muvloom-wordmark-light.svg' : '/brand/muvloom-wordmark-dark.svg'

  return (
    <>
      {!expanded && !showRail && (
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={appMode === 'canvas' ? () => setAppMode('image') : toggleSidebar}
          aria-label={t(appMode === 'canvas' ? 'brand.home' : 'header.nav')}
          autoTooltip={false}
          className="app-floating-mark fixed left-3 top-3 z-40 hidden bg-card/80 text-muted-foreground shadow-lg backdrop-blur-md hover:text-foreground md:inline-flex"
        >
          <img src="/brand/muvloom-mark.svg" alt="" className="h-7 w-7" />
        </Button>
      )}
      {showRail && (
        <nav
          aria-label={t('header.nav')}
          style={{ width: 'var(--app-sidebar-size)' }}
          className="fixed bottom-0 left-0 top-0 z-30 hidden flex-col items-center gap-0.5 overflow-y-auto bg-sidebar pb-4 pt-3 md:flex"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            onClick={toggleSidebar}
            aria-label={t('header.nav')}
            aria-expanded={false}
            autoTooltip={false}
            className="group relative mb-4 shrink-0 text-foreground hover:bg-transparent hover:text-foreground"
          >
            <Icon
              name="sidebar"
              className="!size-6 transition-[opacity,transform] duration-150 group-hover:scale-75 group-hover:opacity-0 group-focus-visible:scale-75 group-focus-visible:opacity-0 motion-reduce:transition-none"
            />
            <img
              src="/brand/muvloom-mark.svg"
              alt=""
              className="absolute h-7 w-7 scale-75 opacity-0 transition-[opacity,transform] duration-150 group-hover:scale-100 group-hover:opacity-100 group-focus-visible:scale-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
            />
          </Button>
          {NAV_APP_MODES.map(item)}
          <div className="min-h-6 flex-1" aria-hidden="true" />
          <a
            href={GUIDE_PATHS[currentLocale()]}
            target="_blank"
            rel="noopener"
            aria-label={t('nav.guide')}
            className="flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon name="guide" />
          </a>
        </nav>
      )}
      {expanded ? (
        // 子项一律不收缩：列表展开变长时由整栏滚动，而不是把每一行压扁。
        <nav
          aria-label={t('header.nav')}
          style={{ width: 'var(--app-sidebar-size)' }}
          className="fixed bottom-0 left-0 top-0 z-30 hidden flex-col gap-0.5 overflow-y-auto overflow-x-hidden bg-sidebar px-2.5 pb-4 pt-3 [&>*]:shrink-0 md:flex"
        >
          <div className="mb-3 flex items-center gap-1 px-1">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setAppMode('image')}
              aria-label={t('header.brandName')}
              autoTooltip={false}
              className="h-auto min-w-0 flex-1 justify-start px-1.5 py-1 hover:bg-transparent"
            >
              <img src={wordmark} alt="" className="h-9 w-auto" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={toggleSidebar}
              aria-label={t('nav.collapse')}
              aria-expanded={true}
              autoTooltip={false}
              className="shrink-0 text-muted-foreground"
            >
              <Icon name="sidebar" />
            </Button>
          </div>
          {NAV_APP_MODES.map(item)}
          <ProjectSection
            label={t('nav.chats')}
            addLabel={t('nav.newChat')}
            projects={chats}
            selectedId={appMode === 'canvas' ? selectedId : undefined}
            opening={opening}
            onAdd={() => void newProject('chat')}
            onOpen={(id) => void openProject(id)}
            onImmersive={(id) => void openProject(id, true)}
            immersiveLabel={t('nav.immersive')}
          />
          <ProjectSection
            label={t('nav.canvases')}
            addLabel={t('nav.newCanvas')}
            projects={canvases}
            selectedId={appMode === 'canvas' ? selectedId : undefined}
            opening={opening}
            onAdd={() => void newProject('canvas')}
            onOpen={(id) => void openProject(id)}
            onImmersive={(id) => void openProject(id, true)}
            immersiveLabel={t('nav.immersive')}
          />
          {/* 画布项目是资产的一部分：「查看全部」去「资产 → 项目」，那时点亮的是「资产」。 */}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={openProjects}
            className="group h-8 justify-start gap-1 px-3 font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
          >
            {t('nav.viewAll')}
            <Icon
              name="arrowRight"
              size="xs"
              className="transition-transform group-hover:translate-x-0.5"
            />
          </Button>
          {/* 列表短时把指南推到栏底；列表长时也和上面隔开一段，不贴着最后一条。 */}
          <div className="min-h-6 flex-1" aria-hidden="true" />
          {/* 指南是独立的静态页，新标签打开，工作台原地不动。 */}
          <a
            href={GUIDE_PATHS[currentLocale()]}
            target="_blank"
            rel="noopener"
            className="flex h-8 items-center gap-2 px-3 text-xs text-muted-foreground hover:text-foreground"
          >
            <Icon name="guide" size="xs" />
            {t('nav.guide')}
          </a>
        </nav>
      ) : null}

      {/* 窄屏没有侧栏的位置：同样四个入口塌成底部标签条。 */}
      <nav
        aria-label={t('header.nav')}
        className="studio-mobile-nav fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-sidebar px-2 md:hidden"
      >
        {NAV_APP_MODES.map((mode) => {
          const active = appMode === mode || (mode === 'image' && appMode === 'canvas')
          return (
            <Button
              key={mode}
              type="button"
              variant="ghost"
              onClick={() => setAppMode(mode)}
              aria-pressed={active}
              className={`h-auto flex-1 flex-col gap-0.5 py-2 text-label-sm font-normal hover:bg-transparent [&_svg]:size-5 ${
                active ? 'text-primary hover:text-primary' : 'text-muted-foreground'
              }`}
            >
              <Icon name={MODE_ICONS[mode]} size="md" filled={active} />
              {APP_MODE_LABELS[mode]}
            </Button>
          )
        })}
      </nav>
    </>
  )
}

function ProjectSection({
  label,
  addLabel,
  projects,
  selectedId,
  opening,
  onAdd,
  onOpen,
  onImmersive,
  immersiveLabel,
}: {
  label: string
  addLabel: string
  projects: readonly CanvasProject[]
  selectedId: string | undefined
  opening: string | null
  onAdd: () => void
  onOpen: (id: string) => void
  onImmersive: (id: string) => void
  immersiveLabel: string
}) {
  return (
    <div className="mt-4">
      <div className="flex h-8 items-center px-3">
        <span className="text-xs font-medium tracking-wide text-muted-foreground">{label}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onAdd}
          aria-label={addLabel}
          autoTooltip={false}
          className="ml-auto text-muted-foreground"
        >
          <Icon name="add" size="xs" />
        </Button>
      </div>
      {projects.map((project) => {
        const active = project.id === selectedId
        const chat = projectExperience(project) === 'chat'
        return (
          <div
            key={project.id}
            className={`group/row flex h-9 items-center gap-2 rounded-md pl-2 pr-1 ${
              active ? ACTIVE_ROW : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <Button
              type="button"
              variant="ghost"
              disabled={opening !== null}
              onClick={() => onOpen(project.id)}
              className="h-full min-w-0 flex-1 justify-start gap-2 px-1 text-body-sm font-normal text-inherit hover:bg-transparent hover:text-inherit disabled:opacity-100"
            >
              <ProjectThumb cover={project.cover} chat={chat} busy={opening === project.id} />
              <span className="truncate">{projectEntryName(project)}</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => onImmersive(project.id)}
              aria-label={immersiveLabel}
              autoTooltip={false}
              className="opacity-0 transition-opacity hover:bg-background focus-visible:opacity-100 group-hover/row:opacity-100"
            >
              <Icon name="fullscreen" size="xs" />
            </Button>
          </div>
        )
      })}
    </div>
  )
}

/** 有封面就用项目封面；空对话用对话图标，空画布用画布图标。封面来自目录上的 `cover`。 */
function ProjectThumb({ cover, chat, busy }: { cover?: string; chat: boolean; busy: boolean }) {
  const [failed, setFailed] = useState(false)
  const showCover = Boolean(cover) && !failed && !busy
  return (
    <span
      data-project-thumb={busy ? 'loading' : showCover ? 'cover' : chat ? 'chat' : 'canvas'}
      className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-md bg-muted text-muted-foreground"
    >
      {busy ? (
        <Icon name="loading" size="xs" className="animate-spin text-primary" />
      ) : showCover && cover ? (
        <MediaImage
          src={cover}
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <Icon name={chat ? 'chat' : 'canvas'} size="xs" />
      )}
    </span>
  )
}

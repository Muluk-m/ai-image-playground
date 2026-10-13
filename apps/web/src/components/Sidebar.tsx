import { useEffect, useState } from 'react'
import { useAgentStore } from '../features/agent/store'
import {
  catalogProjectId,
  projectCatalog,
  projectsByExperience,
  RECENT_PROJECT_COUNT,
} from '../features/canvas/lib/projectCatalog'
import { projectEntryName, projectExperience } from '../features/canvas/lib/projectRepository'
import { useCanvasProjectStore } from '../features/canvas/projectStore'
import { GUIDE_PATHS } from '../features/guide/paths'
import { useLibraryStore } from '../features/library/store'
import { BRAND_WORDMARK, brandNeedsWordmark, currentLocale, useTranslation } from '../i18n'

import {
  APP_MODE_LABELS,
  type AppMode,
  defaultSidebarExpanded,
  NAV_APP_MODES,
  useStore,
} from '../store'
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
/** 主入口选中用中性底，芽绿只留给发送与少量高亮。底色比「正在打开的项目」那一行浅一档。 */
const ACTIVE_ITEM =
  'bg-secondary font-medium text-foreground hover:bg-secondary hover:text-foreground'
const IDLE_ITEM = 'text-muted-foreground hover:bg-muted hover:text-foreground'
const ACTIVE_ROW = 'bg-accent font-medium text-foreground'
type RecentKind = 'chat' | 'canvas'

/**
 * 主导航。**没有顶栏**：品牌在侧栏里，账号与积分浮在右上角，整块主区从屏幕顶端开始。
 * 宽屏是一条 15rem 的栏（四个入口 + 最近画布），窄屏塌成底部标签条。
 * 15rem 才能放下中文品牌「幕芽 Muvloom」，再窄字标会被截成省略号。
 */
export default function Sidebar() {
  const { t } = useTranslation('shell')
  const appMode = useStore((state) => state.appMode)
  const setAppMode = useStore((state) => state.setAppMode)
  const projects = useCanvasProjectStore((state) => state.projects)
  const cloudCatalog = useCanvasProjectStore((state) => state.cloudCatalog)
  const activeId = useCanvasProjectStore((state) => state.activeId)
  // 对话留着这条宽栏，发出消息也不收。画布默认收起：左上角 logo 回首页，旁边按钮可手动展开。
  // 别处默认摊开；用户在当前入口手动开合过，就以他的选择为准。
  const activeProject = projects.find((project) => project.id === activeId)
  const sidebarPreference = useStore((state) => state.sidebarExpanded)
  const expanded =
    sidebarPreference ??
    defaultSidebarExpanded(appMode, activeProject ? projectExperience(activeProject) : null)
  const toggleSidebar = () => useStore.setState({ sidebarExpanded: !expanded })
  // 目录只在画布挂载时加载过；侧栏在别的入口也要列项目，所以自己也拉一次（重复调用是幂等的）。
  useEffect(() => {
    void useCanvasProjectStore.getState().load()
  }, [])
  // 宽度由一个变量说了算：主区、画布与输入框都照它让位。
  useEffect(() => {
    document.documentElement.style.setProperty('--app-sidebar-size', expanded ? '15rem' : '0px')
  }, [expanded])
  const catalog = projectCatalog(projects, cloudCatalog)
  const selectedId = catalogProjectId(activeProject, catalog)
  const recent = catalog.filter((project) => project.hasContent || project.workspaceOpened)
  // 对话与画布共用一块位置，用分组标题上的两个标签切换。项目是异步恢复的、侧栏也不随页面
  // 重挂，所以每次换到另一个项目（或它恢复出来）时跟到它那一类；同一项目下用户手动切的保留。
  const [kind, setKind] = useState<RecentKind>('chat')
  const activeKind = activeProject ? projectExperience(activeProject) : null
  useEffect(() => {
    if (activeKind) setKind(activeKind)
  }, [activeId, activeKind])
  const listed = projectsByExperience(recent)[kind].slice(0, RECENT_PROJECT_COUNT)

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
        className={`${ITEM} ${active ? ACTIVE_ITEM : IDLE_ITEM}`}
      >
        <Icon name={MODE_ICONS[mode]} filled={active} />
        {APP_MODE_LABELS[mode]}
      </Button>
    )
  }

  return (
    <>
      {!expanded && (
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={appMode === 'canvas' ? () => setAppMode('image') : toggleSidebar}
          aria-label={t(appMode === 'canvas' ? 'brand.home' : 'header.nav')}
          className="app-floating-mark fixed left-3 top-3 z-40 hidden bg-card/80 text-muted-foreground shadow-lg backdrop-blur-md hover:text-foreground md:inline-flex"
        >
          <img src="/brand/muvloom-mark.svg" alt="" className="h-7 w-7" />
        </Button>
      )}
      {expanded ? (
        // 子项一律不收缩：列表展开变长时由整栏滚动，而不是把每一行压扁。
        <nav
          aria-label={t('header.nav')}
          style={{ width: 'var(--app-sidebar-size)' }}
          className="fixed bottom-0 left-0 top-0 z-30 hidden flex-col gap-0.5 overflow-y-auto [&>*]:shrink-0 overflow-x-hidden border-r border-border bg-background px-2.5 pb-4 pt-3 md:flex"
        >
          <div className="mb-2 flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setAppMode('image')}
              className="h-auto shrink-0 justify-start gap-2 px-1.5 py-1"
            >
              <img src="/brand/muvloom-mark.svg" alt="" className="h-8 w-8" />
              <span className="whitespace-nowrap text-title font-semibold">
                {t('header.brandName')}
                {brandNeedsWordmark() ? ` ${BRAND_WORDMARK}` : ''}
              </span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={toggleSidebar}
              aria-label={t('nav.collapse')}
              className="text-muted-foreground"
            >
              <Icon name="sidebar" />
            </Button>
          </div>
          {NAV_APP_MODES.map(item)}
          {/* 对话与画布是两种记录；生成结果留在对话里，需要编辑时可新建独立画布。 */}
          <div className="mt-4 flex h-8 items-center gap-3.5 px-3">
            {(['chat', 'canvas'] as const).map((one) => (
              <Button
                key={one}
                type="button"
                variant="link"
                aria-pressed={kind === one}
                onClick={() => setKind(one)}
                className={`h-auto p-0 text-xs font-medium leading-none tracking-wide hover:no-underline ${
                  kind === one ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {t(one === 'chat' ? 'nav.chats' : 'nav.canvases')}
              </Button>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => void newProject(kind)}
              aria-label={t(kind === 'chat' ? 'nav.newChat' : 'nav.newCanvas')}
              title={t(kind === 'chat' ? 'nav.newChat' : 'nav.newCanvas')}
              className="ml-auto text-muted-foreground"
            >
              <Icon name="add" size="xs" />
            </Button>
          </div>
          {listed.map((project) => {
            const active = appMode === 'canvas' && project.id === selectedId
            return (
              <div
                key={project.id}
                className={`group/row flex h-9 items-center gap-2 rounded-md pl-3 pr-1 ${
                  active ? ACTIVE_ROW : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                <Button
                  type="button"
                  variant="ghost"
                  disabled={opening !== null}
                  onClick={() => void openProject(project.id)}
                  className="h-full min-w-0 flex-1 justify-start gap-2.5 px-0 text-body-sm font-normal text-inherit hover:bg-transparent hover:text-inherit disabled:opacity-100"
                >
                  {opening === project.id ? (
                    <Icon name="loading" size="xs" className="animate-spin text-primary" />
                  ) : (
                    <Icon name={kind === 'chat' ? 'chat' : 'canvas'} size="xs" />
                  )}
                  <span className="truncate">{projectEntryName(project)}</span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => void openProject(project.id, true)}
                  aria-label={t('nav.immersive')}
                  title={t('nav.immersive')}
                  className="opacity-0 transition-opacity hover:bg-background focus-visible:opacity-100 group-hover/row:opacity-100"
                >
                  <Icon name="fullscreen" size="xs" />
                </Button>
              </div>
            )
          })}
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
          <div className="flex items-center gap-3 px-3 pb-1 text-label-sm text-muted-foreground">
            <a href="/terms" target="_blank" rel="noopener" className="hover:text-foreground">
              {t('nav.terms')}
            </a>
            <a href="/privacy" target="_blank" rel="noopener" className="hover:text-foreground">
              {t('nav.privacy')}
            </a>
          </div>
        </nav>
      ) : null}

      {/* 窄屏没有侧栏的位置：同样四个入口塌成底部标签条，顶部依旧没有横栏。 */}
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

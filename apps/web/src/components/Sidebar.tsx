import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  LoaderCircle,
  MessageCircle,
  PanelLeftClose,
  Plus,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAgentStore } from '../features/agent/store'
import {
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
import { AssetIcon, CanvasIcon, PromptImageIcon, SparkleIcon, ToolboxIcon } from './icons'

/** 侧栏里每个入口的图标；标签与顺序由 `NAV_APP_MODES` 与语料决定。 */
const MODE_ICONS: Record<AppMode, typeof CanvasIcon> = {
  image: PromptImageIcon,
  canvas: CanvasIcon,
  explore: SparkleIcon,
  library: AssetIcon,
  tools: ToolboxIcon,
}

const ITEM =
  'flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-body-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
/** 主入口选中只换字色，不铺底：底色留给下面「正在打开的项目」那一行。 */
const ACTIVE_ITEM = 'font-semibold text-primary'
const IDLE_ITEM = 'text-muted-foreground hover:bg-muted hover:text-foreground'
const ACTIVE_ROW = 'bg-accent font-medium text-foreground'
type RecentKind = 'chat' | 'canvas'

/**
 * 主导航。**没有顶栏**：品牌在侧栏里，账号与积分浮在右上角，整块主区从屏幕顶端开始。
 * 宽屏是一条 13rem 的栏（四个入口 + 最近画布），窄屏塌成底部标签条。
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
    document.documentElement.style.setProperty('--app-sidebar-size', expanded ? '13rem' : '0px')
  }, [expanded])
  const recent = projectCatalog(projects, cloudCatalog).filter(
    (project) => project.hasContent || project.workspaceOpened,
  )
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
    const Icon = MODE_ICONS[mode]
    const active = appMode === mode || (mode === 'image' && appMode === 'canvas')
    return (
      <button
        key={mode}
        type="button"
        onClick={() => setAppMode(mode)}
        aria-pressed={active}
        aria-label={APP_MODE_LABELS[mode]}
        className={`${ITEM} ${active ? ACTIVE_ITEM : IDLE_ITEM}`}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
        {APP_MODE_LABELS[mode]}
      </button>
    )
  }

  return (
    <>
      {!expanded && (
        <button
          type="button"
          onClick={appMode === 'canvas' ? () => setAppMode('image') : toggleSidebar}
          aria-label={t(appMode === 'canvas' ? 'brand.home' : 'header.nav')}
          className="fixed left-3 top-3 z-40 hidden h-9 w-9 place-items-center rounded-xl border border-border bg-card/80 text-muted-foreground shadow-lg backdrop-blur-md hover:text-foreground md:grid"
        >
          <img src="/brand/muvloom-mark.svg" alt="" className="h-7 w-7" />
        </button>
      )}
      {expanded ? (
        // 子项一律不收缩：列表展开变长时由整栏滚动，而不是把每一行压扁。
        <nav
          aria-label={t('header.nav')}
          style={{ width: 'var(--app-sidebar-size)' }}
          className="fixed bottom-0 left-0 top-0 z-30 hidden flex-col gap-0.5 overflow-y-auto [&>*]:shrink-0 overflow-x-hidden bg-background px-2.5 pb-4 pt-3 md:flex"
        >
          <div className="mb-2 flex items-center gap-1">
            <button
              type="button"
              onClick={() => setAppMode('image')}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-1.5 py-1 text-left hover:bg-muted"
            >
              <img src="/brand/muvloom-mark.svg" alt="" className="h-8 w-8" />
              <span className="truncate text-title font-semibold">
                {t('header.brandName')}
                {brandNeedsWordmark() ? ` ${BRAND_WORDMARK}` : ''}
              </span>
            </button>
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={t('nav.collapse')}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <PanelLeftClose size={16} />
            </button>
          </div>
          {NAV_APP_MODES.map(item)}
          {/* 对话与画布是两种记录；生成结果留在对话里，需要编辑时可新建独立画布。 */}
          <div className="mt-4 flex h-8 items-center gap-3.5 px-3">
            {(['chat', 'canvas'] as const).map((one) => (
              <button
                key={one}
                type="button"
                aria-pressed={kind === one}
                onClick={() => setKind(one)}
                className={`text-[12px] font-medium leading-none tracking-wide ${
                  kind === one
                    ? 'text-foreground'
                    : 'text-muted-foreground/70 hover:text-muted-foreground'
                }`}
              >
                {t(one === 'chat' ? 'nav.chats' : 'nav.canvases')}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void newProject(kind)}
              aria-label={t(kind === 'chat' ? 'nav.newChat' : 'nav.newCanvas')}
              title={t(kind === 'chat' ? 'nav.newChat' : 'nav.newCanvas')}
              className="ml-auto grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          {listed.map((project) => {
            const active = appMode === 'canvas' && project.id === activeId
            return (
              <div
                key={project.id}
                className={`group/row flex h-9 items-center gap-2 rounded-xl px-3 ${
                  active ? ACTIVE_ROW : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                <button
                  type="button"
                  disabled={opening !== null}
                  onClick={() => void openProject(project.id)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left text-body-sm"
                >
                  {opening === project.id ? (
                    <LoaderCircle
                      className="h-3.5 w-3.5 shrink-0 animate-spin text-primary"
                      aria-hidden="true"
                    />
                  ) : kind === 'chat' ? (
                    <MessageCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <CanvasIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  )}
                  <span className="truncate">{projectEntryName(project)}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void openProject(project.id, true)}
                  aria-label={t('nav.immersive')}
                  title={t('nav.immersive')}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-md opacity-0 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
                >
                  <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            )
          })}
          {/* 画布项目是资产的一部分：「查看全部」去「资产 → 项目」，那时点亮的是「资产」。 */}
          <button
            type="button"
            onClick={openProjects}
            className="group flex h-8 items-center gap-1 px-3 text-left text-xs text-muted-foreground hover:text-foreground"
          >
            {t('nav.viewAll')}
            <ArrowRight
              className="h-3 w-3 transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </button>
          {/* 列表短时把指南推到栏底；列表长时也和上面隔开一段，不贴着最后一条。 */}
          <div className="min-h-6 flex-1" aria-hidden="true" />
          {/* 指南是独立的静态页，新标签打开，工作台原地不动。 */}
          <a
            href={GUIDE_PATHS[currentLocale()]}
            target="_blank"
            rel="noopener"
            className="flex h-8 items-center gap-2 px-3 text-[12px] text-muted-foreground hover:text-foreground"
          >
            <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
            {t('nav.guide')}
          </a>
        </nav>
      ) : null}

      {/* 窄屏没有侧栏的位置：同样四个入口塌成底部标签条，顶部依旧没有横栏。 */}
      <nav
        aria-label={t('header.nav')}
        className="studio-mobile-nav fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-sidebar px-2 md:hidden"
      >
        {NAV_APP_MODES.map((mode) => {
          const Icon = MODE_ICONS[mode]
          const active = appMode === mode || (mode === 'image' && appMode === 'canvas')
          return (
            <button
              key={mode}
              type="button"
              onClick={() => setAppMode(mode)}
              aria-pressed={active}
              className={`flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-label-sm ${
                active ? 'text-primary' : 'text-muted-foreground'
              }`}
            >
              <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
              {APP_MODE_LABELS[mode]}
            </button>
          )
        })}
      </nav>
    </>
  )
}

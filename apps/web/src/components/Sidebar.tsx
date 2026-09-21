import { useEffect } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useAgentStore } from '../features/agent/store'
import { projectCatalog } from '../features/canvas/lib/projectCatalog'
import { projectDisplayName } from '../features/canvas/lib/projectRepository'
import { useCanvasProjectStore } from '../features/canvas/projectStore'
import { BRAND_WORDMARK, brandNeedsWordmark, useTranslation } from '../i18n'
import { PrivateWebSidebarAccountCard } from '../lib/privateOverlay'
import { APP_MODE_LABELS, type AppMode, isWorkbenchMode, NAV_APP_MODES, useStore } from '../store'
import { AssetIcon, CanvasIcon, GalleryIcon, PromptImageIcon, SparkleIcon } from './icons'

/** 侧栏里每个入口的图标；标签与顺序由 `NAV_APP_MODES` 与语料决定。 */
const MODE_ICONS: Record<AppMode, typeof CanvasIcon> = {
  image: PromptImageIcon,
  canvas: CanvasIcon,
  explore: SparkleIcon,
  projects: GalleryIcon,
  library: AssetIcon,
}

const ITEM =
  'flex h-10 w-full items-center gap-2.5 rounded-xl px-3 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const ACTIVE_ITEM = 'bg-accent font-medium text-foreground'
const IDLE_ITEM = 'text-muted-foreground hover:bg-muted hover:text-foreground'

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
  const username = useAuth().user?.username ?? null
  // 画布要整屏，所以那里默认收起；别处默认摊开。用户手动切过就以他的选择为准。
  const expanded = useStore((state) => state.sidebarExpanded ?? !isWorkbenchMode(state.appMode))
  const toggleSidebar = useStore((state) => state.toggleSidebar)
  // 目录只在画布挂载时加载过；侧栏在别的入口也要列项目，所以自己也拉一次（重复调用是幂等的）。
  useEffect(() => {
    void useCanvasProjectStore.getState().load()
  }, [])
  // 宽度由一个变量说了算：主区、画布与输入框都照它让位。
  useEffect(() => {
    document.documentElement.style.setProperty('--app-sidebar-size', expanded ? '13rem' : '0px')
  }, [expanded])
  const recent = projectCatalog(projects, cloudCatalog)
    .filter((project) => project.hasContent)
    .slice(0, 4)

  const openProject = async (id: string, immersive = false) => {
    if (!(await useAgentStore.getState().selectProject(id))) return
    setAppMode('canvas')
    // 沉浸式打开：进画布顺手把侧栏收掉。必须排在 setAppMode 后面——它会把这个选择复位成
    // 「按入口默认」。
    if (immersive) useStore.setState({ sidebarExpanded: false })
  }

  const newProject = async () => {
    if (await useAgentStore.getState().createProject()) setAppMode('canvas')
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
        <Icon className={`h-4 w-4 ${active ? 'text-primary' : ''}`} aria-hidden="true" />
        {APP_MODE_LABELS[mode]}
      </button>
    )
  }

  return (
    <>
      {!expanded && (
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={t('header.nav')}
          className="fixed left-3 top-3 z-40 hidden h-9 w-9 place-items-center rounded-xl border border-border bg-card/80 text-muted-foreground shadow-lg backdrop-blur-md hover:text-foreground md:grid"
        >
          <img src="/brand/icon-512.png" alt="" className="h-6 w-6 rounded-lg" />
        </button>
      )}
      {expanded ? (
        <nav
          aria-label={t('header.nav')}
          style={{ width: 'var(--app-sidebar-size)' }}
          className="fixed bottom-0 left-0 top-0 z-30 hidden flex-col gap-0.5 overflow-y-auto overflow-x-hidden border-r border-border bg-sidebar px-2.5 pb-4 pt-3 md:flex"
        >
          <div className="mb-2 flex items-center gap-1">
            <button
              type="button"
              onClick={() => setAppMode('image')}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-1.5 py-1 text-left hover:bg-muted"
            >
              <img src="/brand/icon-512.png" alt="" className="h-7 w-7 rounded-lg" />
              <span className="truncate text-[15px] font-semibold">
                {t('header.brandName')}
                {brandNeedsWordmark() ? ` ${BRAND_WORDMARK}` : ''}
              </span>
            </button>
            {/* 画布要整屏：这里收起侧栏，收起后左上角留一颗品牌按钮把它叫回来。 */}
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={t('nav.collapse')}
              title={t('nav.collapse')}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              ‹
            </button>
          </div>
          {NAV_APP_MODES.map(item)}
          {/* 画布分段：标题行 hover 出「全部 ＋」，条目 hover 出 ↗（沉浸式打开：进去就收起侧栏）。 */}
          <div className="group/head flex items-center gap-1 px-3 pb-1 pt-4">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t('nav.canvases')}
            </span>
            <span className="ml-auto flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/head:opacity-100">
              <button
                type="button"
                onClick={() => setAppMode('projects')}
                className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {t('nav.allCanvases')}
              </button>
              <button
                type="button"
                onClick={() => void newProject()}
                aria-label={t('nav.newCanvas')}
                title={t('nav.newCanvas')}
                className="grid h-5 w-5 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                +
              </button>
            </span>
          </div>
          {recent.map((project) => {
            const active = appMode === 'canvas' && project.id === activeId
            return (
              <div
                key={project.id}
                className={`group/row flex h-9 items-center gap-2 rounded-xl px-3 ${
                  active ? ACTIVE_ITEM : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                <button
                  type="button"
                  onClick={() => void openProject(project.id)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left text-[13px]"
                >
                  <CanvasIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{projectDisplayName(project.name)}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void openProject(project.id, true)}
                  aria-label={t('nav.immersive')}
                  title={t('nav.immersive')}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-md opacity-0 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
                >
                  ↗
                </button>
              </div>
            )
          })}
          {PrivateWebSidebarAccountCard ? (
            <PrivateWebSidebarAccountCard username={username} />
          ) : null}
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
              className={`flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] ${
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

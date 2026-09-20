import { useEffect } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useAgentStore } from '../features/agent/store'
import { projectCatalog } from '../features/canvas/lib/projectCatalog'
import { projectDisplayName } from '../features/canvas/lib/projectRepository'
import { useCanvasProjectStore } from '../features/canvas/projectStore'
import { BRAND_WORDMARK, brandNeedsWordmark, useTranslation } from '../i18n'
import { PrivateWebSidebarAccountCard } from '../lib/privateOverlay'
import { APP_MODE_LABELS, type AppMode, NAV_APP_MODES, useStore } from '../store'
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
  // 目录只在画布挂载时加载过；侧栏在别的入口也要列项目，所以自己也拉一次（重复调用是幂等的）。
  useEffect(() => {
    void useCanvasProjectStore.getState().load()
  }, [])
  const recent = projectCatalog(projects, cloudCatalog)
    .filter((project) => project.hasContent)
    .slice(0, 4)

  const openProject = async (id: string) => {
    if (await useAgentStore.getState().selectProject(id)) setAppMode('canvas')
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
      <nav
        aria-label={t('header.nav')}
        style={{ width: 'var(--app-sidebar-size)' }}
        className="fixed bottom-0 left-0 top-0 z-30 hidden flex-col gap-0.5 overflow-y-auto overflow-x-hidden border-r border-border bg-sidebar px-2.5 pb-4 pt-3 md:flex"
      >
        <button
          type="button"
          onClick={() => setAppMode('image')}
          className="mb-2 flex items-center gap-2 rounded-xl px-1.5 py-1 text-left hover:bg-muted"
        >
          <img src="/brand/muvloom-icon.svg" alt="" className="h-7 w-7 rounded-lg" />
          <span className="truncate text-[15px] font-semibold">
            {t('header.brandName')}
            {brandNeedsWordmark() ? ` ${BRAND_WORDMARK}` : ''}
          </span>
        </button>
        {NAV_APP_MODES.map(item)}
        {recent.length > 0 && (
          <p className="px-3 pb-1 pt-4 text-[10px] font-semibold tracking-[0.16em] text-muted-foreground">
            {t('nav.recentCanvases')}
          </p>
        )}
        {recent.map((project) => (
          <button
            key={project.id}
            type="button"
            onClick={() => void openProject(project.id)}
            className={`${ITEM} h-9 text-[13px] ${appMode === 'canvas' && project.id === activeId ? ACTIVE_ITEM : IDLE_ITEM}`}
          >
            <CanvasIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{projectDisplayName(project.name)}</span>
          </button>
        ))}
        {PrivateWebSidebarAccountCard ? <PrivateWebSidebarAccountCard username={username} /> : null}
      </nav>

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

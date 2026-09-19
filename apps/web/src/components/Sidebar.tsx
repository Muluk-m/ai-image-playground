import { useEffect } from 'react'
import { useAgentStore } from '../features/agent/store'
import { projectCatalog } from '../features/canvas/lib/projectCatalog'
import { projectDisplayName } from '../features/canvas/lib/projectRepository'
import { useCanvasProjectStore } from '../features/canvas/projectStore'
import { useTranslation } from '../i18n'
import {
  APP_MODE_LABELS,
  type AppMode,
  isWorkbenchMode,
  LIBRARY_APP_MODES,
  useStore,
  visibleAppModes,
} from '../store'
import {
  AssetIcon,
  CanvasIcon,
  GalleryIcon,
  PromptImageIcon,
  TemplateIcon,
  VideoIcon,
} from './icons'
import { HEADER_OFFSET } from './panelStyles'

/** 侧栏里每个入口的图标；标签与顺序由 `visibleAppModes`、`LIBRARY_APP_MODES` 与语料决定。 */
const MODE_ICONS: Record<AppMode, typeof CanvasIcon> = {
  image: PromptImageIcon,
  canvas: CanvasIcon,
  video: VideoIcon,
  works: GalleryIcon,
  assets: AssetIcon,
  templates: TemplateIcon,
  projects: CanvasIcon,
}

const ITEM =
  'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const ACTIVE_ITEM = 'bg-accent font-medium text-foreground'
const IDLE_ITEM = 'text-muted-foreground hover:bg-muted hover:text-foreground'
const GROUP = 'px-2.5 pb-1 pt-3.5 text-[10px] font-semibold tracking-[0.16em] text-muted-foreground'

/**
 * 主导航：上半是创作入口（生图 / 画布 / 视频），下半是三个库（作品 / 素材 / 模板），
 * 再下面是最近的画布项目。只在宽屏出现；窄屏由顶栏的分段控件承担同一份列表。
 */
export default function Sidebar() {
  const { t } = useTranslation('shell')
  const appMode = useStore((state) => state.appMode)
  const setAppMode = useStore((state) => state.setAppMode)
  const sidebarExpanded = useStore((state) => state.sidebarExpanded)
  const toggleSidebar = useStore((state) => state.toggleSidebar)
  const projects = useCanvasProjectStore((state) => state.projects)
  const cloudCatalog = useCanvasProjectStore((state) => state.cloudCatalog)
  const activeId = useCanvasProjectStore((state) => state.activeId)
  const creation = visibleAppModes()
  const expanded = sidebarExpanded ?? !isWorkbenchMode(appMode)
  // 目录只在画布挂载时加载过；侧栏在别的入口也要列项目，所以自己也拉一次（重复调用是幂等的）。
  useEffect(() => {
    void useCanvasProjectStore.getState().load()
  }, [])
  // 宽度由一个变量说了算：主区、画布与输入框都照它让位，收起时只剩一条图标栏。
  useEffect(() => {
    document.documentElement.style.setProperty('--app-sidebar-size', expanded ? '15rem' : '3.25rem')
  }, [expanded])
  const recent = projectCatalog(projects, cloudCatalog)
    .filter((project) => project.hasContent)
    .slice(0, 5)

  const openProject = async (id: string) => {
    if (await useAgentStore.getState().selectProject(id)) setAppMode('canvas')
  }

  const item = (mode: AppMode) => {
    const Icon = MODE_ICONS[mode]
    const active = appMode === mode
    return (
      <button
        key={mode}
        type="button"
        onClick={() => setAppMode(mode)}
        aria-pressed={active}
        title={expanded ? undefined : APP_MODE_LABELS[mode]}
        aria-label={APP_MODE_LABELS[mode]}
        className={`${ITEM} ${expanded ? '' : 'justify-center px-0'} ${active ? ACTIVE_ITEM : IDLE_ITEM}`}
      >
        <Icon className={`h-[15px] w-[15px] ${active ? 'text-primary' : ''}`} aria-hidden="true" />
        {expanded ? APP_MODE_LABELS[mode] : null}
      </button>
    )
  }

  return (
    <nav
      aria-label={t('header.nav')}
      style={{ top: HEADER_OFFSET, width: 'var(--app-sidebar-size)' }}
      className="fixed bottom-0 left-0 z-30 hidden flex-col overflow-y-auto overflow-x-hidden border-r border-border bg-sidebar px-2 pb-4 md:flex"
    >
      <button
        type="button"
        onClick={toggleSidebar}
        aria-expanded={expanded}
        aria-label={t(expanded ? 'nav.collapse' : 'nav.expand')}
        title={t(expanded ? 'nav.collapse' : 'nav.expand')}
        className={`${ITEM} ${expanded ? 'justify-end' : 'justify-center px-0'} ${IDLE_ITEM} mt-2`}
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
          <path
            d={expanded ? 'M10 3.5 5.5 8l4.5 4.5' : 'M6 3.5 10.5 8 6 12.5'}
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {expanded ? <p className={GROUP}>{t('nav.create')}</p> : null}
      {creation.map(item)}
      {expanded ? (
        <p className={GROUP}>{t('nav.mine')}</p>
      ) : (
        <div className="my-2 h-px bg-border" />
      )}
      {LIBRARY_APP_MODES.map(item)}

      {expanded ? (
        <>
          <p className={GROUP}>{t('nav.recentCanvases')}</p>
          {recent.map((project) => (
            <button
              key={project.id}
              type="button"
              onClick={() => void openProject(project.id)}
              className={`${ITEM} ${appMode === 'canvas' && project.id === activeId ? ACTIVE_ITEM : IDLE_ITEM}`}
            >
              <span className="truncate">{projectDisplayName(project.name)}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setAppMode('projects')}
            aria-pressed={appMode === 'projects'}
            className={`${ITEM} ${appMode === 'projects' ? ACTIVE_ITEM : IDLE_ITEM}`}
          >
            {t('nav.allProjects')}
          </button>
        </>
      ) : null}
    </nav>
  )
}

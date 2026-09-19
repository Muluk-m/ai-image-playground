import { useEffect } from 'react'
import { useAgentStore } from '../features/agent/store'
import { projectCatalog } from '../features/canvas/lib/projectCatalog'
import { projectDisplayName } from '../features/canvas/lib/projectRepository'
import { useCanvasProjectStore } from '../features/canvas/projectStore'
import { useInspirationStore } from '../features/inspiration/store'
import { useLibraryStore } from '../features/library/store'
import { useTranslation } from '../i18n'
import { APP_MODE_LABELS, type AppMode, useStore, visibleAppModes } from '../store'
import {
  CanvasIcon,
  LibraryIcon,
  PromptImageIcon,
  SparkleIcon,
  TemplateIcon,
  VideoIcon,
} from './icons'
import { HEADER_OFFSET } from './panelStyles'

/** 侧栏里每个入口的图标；标签与顺序由 `visibleAppModes` 与语料决定。 */
const MODE_ICONS: Record<AppMode, typeof CanvasIcon> = {
  image: PromptImageIcon,
  canvas: CanvasIcon,
  video: VideoIcon,
  works: LibraryIcon,
}

const ITEM =
  'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const ACTIVE_ITEM = 'bg-accent font-medium text-foreground'
const IDLE_ITEM = 'text-muted-foreground hover:bg-muted hover:text-foreground'
const GROUP = 'px-2.5 pb-1 pt-3.5 text-[10px] font-semibold tracking-[0.16em] text-muted-foreground'

/**
 * 主导航：上半是三个创作入口（生图 / 画布 / 视频），下半是三个库（作品 / 素材 / 模板）与灵感库，
 * 再下面是最近的画布项目。只在宽屏出现；窄屏由顶栏的分段控件承担同一份 `visibleAppModes`。
 */
export default function Sidebar() {
  const { t } = useTranslation('shell')
  const appMode = useStore((state) => state.appMode)
  const setAppMode = useStore((state) => state.setAppMode)
  const openLibrary = useLibraryStore((state) => state.openPanel)
  const openInspiration = useInspirationStore((state) => state.openPanel)
  const projects = useCanvasProjectStore((state) => state.projects)
  const cloudCatalog = useCanvasProjectStore((state) => state.cloudCatalog)
  const activeId = useCanvasProjectStore((state) => state.activeId)
  const modes = visibleAppModes()
  const creation = modes.filter((mode) => mode !== 'works')
  // 目录只在画布挂载时加载过；侧栏在别的入口也要列项目，所以自己也拉一次（重复调用是幂等的）。
  useEffect(() => {
    void useCanvasProjectStore.getState().load()
  }, [])
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
        className={`${ITEM} ${active ? ACTIVE_ITEM : IDLE_ITEM}`}
      >
        <Icon className={`h-[15px] w-[15px] ${active ? 'text-primary' : ''}`} aria-hidden="true" />
        {APP_MODE_LABELS[mode]}
      </button>
    )
  }

  return (
    <nav
      aria-label={t('header.nav')}
      style={{ top: HEADER_OFFSET }}
      className="fixed bottom-0 left-0 z-30 hidden w-60 flex-col overflow-y-auto border-r border-border bg-sidebar px-2 pb-4 md:flex"
    >
      <p className={GROUP}>{t('nav.create')}</p>
      {creation.map(item)}
      <p className={GROUP}>{t('nav.mine')}</p>
      {modes.includes('works') ? item('works') : null}
      <button
        type="button"
        onClick={() => openLibrary('assets')}
        className={`${ITEM} ${IDLE_ITEM}`}
      >
        <LibraryIcon className="h-[15px] w-[15px]" aria-hidden="true" />
        {t('nav.assets')}
      </button>
      <button
        type="button"
        onClick={() => openLibrary('templates')}
        className={`${ITEM} ${IDLE_ITEM}`}
      >
        <TemplateIcon className="h-[15px] w-[15px]" aria-hidden="true" />
        {t('nav.templates')}
      </button>
      <button type="button" onClick={() => openInspiration()} className={`${ITEM} ${IDLE_ITEM}`}>
        <SparkleIcon className="h-[15px] w-[15px]" aria-hidden="true" />
        {t('header.inspiration')}
      </button>

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
        onClick={() => openLibrary('projects')}
        className={`${ITEM} ${IDLE_ITEM}`}
      >
        {t('nav.allProjects')}
      </button>
    </nav>
  )
}

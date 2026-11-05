import { readProjectRoute, writeProjectRoute } from '../../features/canvas/lib/projectRoute'
import { useCanvasProjectStore } from '../../features/canvas/projectStore'
import { toolPath } from '../../features/toolbox/lib/toolRoute'
import { useToolboxStore } from '../../features/toolbox/store'
import { APP_MODE_PATHS, isChangelogPath, isStandalonePath, type RoutedAppMode } from '../appPaths'

function isRoot(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === ''
}

/** 全局 activeId 可能属于上一个账号或已被删除；只有项目目录已加载且项目还在才能写进地址。 */
function usableProject(id: string | null): id is string {
  if (!id) return false
  const { loaded, projects } = useCanvasProjectStore.getState()
  return loaded && projects.some((one) => one.id === id && !one.cloud?.deleted)
}

export function writeModeAddress(
  mode: RoutedAppMode | 'canvas',
  active: string | null,
  retried = false,
): void {
  const { pathname, search, hash } = window.location
  // 定价、条款、隐私、设备页不是工作台入口。别处改 appMode 不能把人从这些地址带走。
  // 更新页挂在同一套侧栏里，选别的入口要离开 /changelog。
  if (isStandalonePath(pathname) && !isChangelogPath(pathname)) return
  if (mode !== 'canvas') {
    // 回到工具箱时落在刚才那件工具上：导入的图还在，接着用。
    const target =
      mode === 'tools' ? toolPath(useToolboxStore.getState().activeTool) : APP_MODE_PATHS[mode]
    if (pathname !== target) window.history.pushState(null, '', `${target}${search}${hash}`)
    return
  }
  // 已经在项目地址上：项目导航自己负责。
  if (readProjectRoute(pathname) !== null) return
  // 画布只从项目进；没有可用项目就退回创作地址，别把人留在一个没有归属的 `/`。
  if (usableProject(active)) writeProjectRoute(active, isRoot(pathname))
  else if (active && !useCanvasProjectStore.getState().loaded && !retried) {
    // 目录还在加载：活动项目可能是有效的，等加载完再决定，而不是直接把这次点击丢给创作页。
    // 加载期间人又去了别处（地址变了）就放弃这次导航。
    const from = pathname
    const settle = () => {
      if (window.location.pathname !== from) return
      writeModeAddress('canvas', useCanvasProjectStore.getState().activeId, true)
    }
    void useCanvasProjectStore.getState().load().then(settle, settle)
  } else window.history.pushState(null, '', `${APP_MODE_PATHS.image}${search}${hash}`)
}

/** Project activation also corrects old URLs when the active ID has not changed. */
export function projectActivated(projectId: string, replaceRoute = false): void {
  if (readProjectRoute(globalThis.location?.pathname ?? '/') !== null)
    writeProjectRoute(projectId, replaceRoute)
}

/** The caller owns whether its workspace has started; only a root address is published. */
export function publishStartedProjectAddress(projectId: string): void {
  if (isRoot(globalThis.location?.pathname ?? '/')) writeProjectRoute(projectId)
}

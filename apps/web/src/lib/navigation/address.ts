import { readProjectRoute, writeProjectRoute } from '../../features/canvas/lib/projectRoute'
import { toolPath } from '../../features/toolbox/lib/toolRoute'
import { useToolboxStore } from '../../features/toolbox/store'
import { APP_MODE_PATHS, isChangelogPath, isStandalonePath, type RoutedAppMode } from '../appPaths'
import { notifyPathname } from '../pathname'

function isRoot(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === ''
}

export function writeModeAddress(mode: RoutedAppMode | 'canvas', active: string | null): void {
  const { pathname, search, hash } = window.location
  const before = pathname
  // 定价、条款、隐私、接入和设备页不是工作台入口。别处改 appMode 不能把人从这些地址带走。
  // 更新页挂在同一套侧栏里，选别的入口要离开 /changelog。
  if (!(isStandalonePath(pathname) && !isChangelogPath(pathname))) {
    if (mode !== 'canvas') {
      // 回到工具箱时落在刚才那件工具上：导入的图还在，接着用。
      const target =
        mode === 'tools' ? toolPath(useToolboxStore.getState().activeTool) : APP_MODE_PATHS[mode]
      if (pathname !== target) window.history.pushState(null, '', `${target}${search}${hash}`)
    } else if (readProjectRoute(pathname) === null) {
      // 画布只从项目进；没有活动项目就退回创作地址，别把人留在一个没有归属的 `/`。
      if (active) writeProjectRoute(active, isRoot(pathname))
      else window.history.pushState(null, '', `${APP_MODE_PATHS.image}${search}${hash}`)
    }
  }
  if (window.location.pathname !== before) notifyPathname()
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

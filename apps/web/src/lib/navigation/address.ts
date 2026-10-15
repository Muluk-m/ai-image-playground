import { readProjectRoute, writeProjectRoute } from '../../features/canvas/lib/projectRoute'
import { APP_MODE_PATHS, isStandalonePath, type RoutedAppMode } from '../appPaths'

function isRoot(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === ''
}

export function writeModeAddress(mode: RoutedAppMode | 'canvas', active: string | null): void {
  const { pathname, search, hash } = window.location
  // 定价、条款、隐私不是工作台入口。别处改 appMode 不能把人从这些地址带走。
  if (isStandalonePath(pathname)) return
  if (mode !== 'canvas') {
    const target = APP_MODE_PATHS[mode]
    if (pathname !== target) window.history.pushState(null, '', `${target}${search}${hash}`)
    return
  }
  // 已经在项目地址上：项目导航自己负责。
  if (readProjectRoute(pathname) !== null) return
  // 画布只从项目进；没有活动项目就退回创作地址，别把人留在一个没有归属的 `/`。
  if (active) writeProjectRoute(active, isRoot(pathname))
  else window.history.pushState(null, '', `${APP_MODE_PATHS.image}${search}${hash}`)
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

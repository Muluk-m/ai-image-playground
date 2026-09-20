import { readProjectRoute, writeProjectRoute } from '../features/canvas/lib/projectRoute'
import { useCanvasProjectStore } from '../features/canvas/projectStore'
import { type AppMode, useStore } from '../store'
import { APP_MODE_PATHS, pathAppMode } from './appPaths'

/**
 * 四个入口各有自己的地址：创作 `/image`、探索 `/explore`、项目 `/projects`、资产 `/assets`。
 * 画布不是导航项，它住在项目地址 `/p/<项目>`。切换入口写一条历史记录，前进后退和刷新都回到同一个入口。
 * 根地址 `/` 属于创作——进站不再被当前项目劫持到画布。
 */

function isRoot(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === ''
}

function writeModeRoute(mode: AppMode): void {
  const { pathname, search, hash } = window.location
  if (mode !== 'canvas') {
    const target = APP_MODE_PATHS[mode]
    if (pathname !== target) window.history.pushState(null, '', `${target}${search}${hash}`)
    return
  }
  // 已经在项目地址上：项目导航自己负责。
  if (readProjectRoute(pathname) !== null) return
  const active = useCanvasProjectStore.getState().activeId
  // 画布只从项目进；没有活动项目就退回创作地址，别把人留在一个没有归属的 `/`。
  if (active) writeProjectRoute(active, isRoot(pathname))
  else window.history.pushState(null, '', `${APP_MODE_PATHS.image}${search}${hash}`)
}

/** 入口和地址双向同步。要在项目目录加载前装上，加载完激活项目时才不会把生图 / 作品地址改成项目地址。 */
export function installAppRouting(): () => void {
  const sync = () => {
    const { pathname } = window.location
    const mode = pathAppMode(pathname) ?? (isRoot(pathname) ? 'image' : null)
    // 项目地址由项目导航切回画布。
    if (mode && useStore.getState().appMode !== mode) useStore.getState().setAppMode(mode)
  }
  sync()
  const unsubscribe = useStore.subscribe((state, prev) => {
    if (state.appMode !== prev.appMode) writeModeRoute(state.appMode)
  })
  window.addEventListener('popstate', sync)
  return () => {
    unsubscribe()
    window.removeEventListener('popstate', sync)
  }
}

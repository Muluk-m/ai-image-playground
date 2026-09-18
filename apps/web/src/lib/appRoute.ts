import { readProjectRoute, writeProjectRoute } from '../features/canvas/lib/projectRoute'
import { useCanvasProjectStore } from '../features/canvas/projectStore'
import { type AppMode, useStore } from '../store'
import { APP_MODE_PATHS, pathAppMode } from './appPaths'

/**
 * 顶部三个入口各有自己的地址：创作是 `/p/<项目>`（没有项目时是 `/`），作品是 `/works`，
 * 视频是 `/video`。切换入口写一条历史记录，前进后退和刷新都回到同一个入口。
 */

function isRoot(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === ''
}

function writeModeRoute(mode: AppMode): void {
  const { pathname, search, hash } = window.location
  if (mode !== 'create') {
    const target = APP_MODE_PATHS[mode]
    if (pathname !== target) window.history.pushState(null, '', `${target}${search}${hash}`)
    return
  }
  // 已经在项目地址上：项目导航自己负责。
  if (readProjectRoute(pathname) !== null) return
  const active = useCanvasProjectStore.getState().activeId
  // 从 `/` 进来只是补上项目地址，不多留一条历史。
  if (active) writeProjectRoute(active, isRoot(pathname))
  else if (!isRoot(pathname)) window.history.pushState(null, '', `/${search}${hash}`)
}

/** 入口和地址双向同步。要在项目目录加载前装上，加载完激活项目时才不会把作品 / 视频地址改成项目地址。 */
export function installAppRouting(): () => void {
  const sync = () => {
    const { pathname } = window.location
    const mode = pathAppMode(pathname) ?? (isRoot(pathname) ? 'create' : null)
    // 项目地址由项目导航切回创作。
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

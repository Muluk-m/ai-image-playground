import { useAgentStore } from '../../features/agent/store'
import {
  readProjectRoute,
  resolveProjectRoute,
  writeProjectRoute,
} from '../../features/canvas/lib/projectRoute'
import { useCanvasProjectStore } from '../../features/canvas/projectStore'
import { useLibraryStore } from '../../features/library/store'
import { i18next } from '../../i18n'
import { useStore } from '../../store'
import { LEGACY_PROJECTS_PATH, normalizePath, pathAppMode } from '../appPaths'
import { writeModeAddress } from './address'

/** Owns address synchronization order and the browser-only project navigation queue. */
export function installWorkbenchNavigation(): () => void {
  const sync = () => {
    const { pathname } = window.location
    const mode = pathAppMode(pathname) ?? (normalizePath(pathname) === '/' ? 'image' : null)
    if (pathname.replace(/\/+$/, '') === LEGACY_PROJECTS_PATH)
      useLibraryStore.getState().setTab('projects')
    // 项目地址由项目导航切回画布。
    if (mode && useStore.getState().appMode !== mode) useStore.getState().setAppMode(mode)
  }
  // Initial root synchronization must run before mode changes start writing history.
  sync()
  const unsubscribe = useStore.subscribe((state, prev) => {
    if (state.appMode !== prev.appMode)
      writeModeAddress(state.appMode, useCanvasProjectStore.getState().activeId)
  })
  window.addEventListener('popstate', sync)
  let revision = 0
  let pending = Promise.resolve()
  const navigate = () => {
    const current = ++revision
    const id = readProjectRoute()
    if (!id) return
    const isCurrent = () => {
      const route = readProjectRoute()
      const projects = useCanvasProjectStore.getState().projects
      return (
        current === revision &&
        route !== null &&
        resolveProjectRoute(route, projects) === resolveProjectRoute(id, projects)
      )
    }
    pending = pending.then(async () => {
      if (!isCurrent()) return
      useCanvasProjectStore.setState({ routeError: null })
      useStore.getState().setAppMode('canvas')
      try {
        const project = await useCanvasProjectStore.getState().resolve(id)
        if (!isCurrent()) return
        const opened = await useAgentStore.getState().selectProject(project.id, isCurrent)
        if (!isCurrent()) return
        if (opened) useLibraryStore.getState().leaveLibraryPage()
        else {
          const active = useCanvasProjectStore.getState().activeId
          if (active) writeProjectRoute(active, true)
        }
      } catch {
        if (!isCurrent()) return
        useCanvasProjectStore.setState({
          routeError: i18next.t('project.routeUnavailable', { ns: 'canvas' }),
        })
      }
    })
  }
  window.addEventListener('popstate', navigate)
  void navigate()
  return () => {
    unsubscribe()
    window.removeEventListener('popstate', sync)
    revision++
    window.removeEventListener('popstate', navigate)
  }
}

/** 地址里那个项目打不开时的退路：回到当前项目的地址，没有当前项目就回首页。 */
export function backToCurrentProject(): void {
  const active = useCanvasProjectStore.getState().activeId
  if (!active) {
    location.assign('/')
    return
  }
  writeProjectRoute(active, true)
  useCanvasProjectStore.setState({ routeError: null })
}

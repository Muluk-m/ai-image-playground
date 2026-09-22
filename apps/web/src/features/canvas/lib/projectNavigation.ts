import { i18next } from '../../../i18n'
import { useStore } from '../../../store'
import { useAgentStore } from '../../agent/store'
import { useLibraryStore } from '../../library/store'
import { useCanvasProjectStore } from '../projectStore'
import { readProjectRoute, resolveProjectRoute, writeProjectRoute } from './projectRoute'

/** Browser navigation uses the same save/switch boundary as the project picker. */
export function installProjectNavigation(): () => void {
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
    revision++
    window.removeEventListener('popstate', navigate)
  }
}

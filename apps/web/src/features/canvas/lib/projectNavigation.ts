import { useStore } from '../../../store'
import { useAgentStore } from '../../agent/store'
import { useLibraryStore } from '../../library/store'
import { useCanvasProjectStore } from '../projectStore'
import { readProjectRoute, writeProjectRoute } from './projectRoute'

/** Browser navigation uses the same save/switch boundary as the project picker. */
export function installProjectNavigation(): () => void {
  let revision = 0
  let pending = Promise.resolve()
  const navigate = () => {
    const current = ++revision
    const id = readProjectRoute()
    if (!id) return
    const isCurrent = () => current === revision && readProjectRoute() === id
    pending = pending.then(async () => {
      if (!isCurrent()) return
      useCanvasProjectStore.setState({ routeError: null })
      useStore.getState().setAppMode('create')
      try {
        await useCanvasProjectStore.getState().resolve(id)
        if (!isCurrent()) return
        const opened = await useAgentStore.getState().selectProject(id, isCurrent)
        if (!isCurrent()) return
        if (opened) useLibraryStore.getState().closePanel()
        else {
          const active = useCanvasProjectStore.getState().activeId
          if (active) writeProjectRoute(active, true)
        }
      } catch {
        if (!isCurrent()) return
        useCanvasProjectStore.setState({
          routeError: '此项目暂时无法打开，请确认账号或在原设备重试。',
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

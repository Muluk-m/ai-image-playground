import i18next from 'i18next'
import { useStore } from '../../../store'
import { useAgentStore } from '../../agent/store'
import { useCanvasProjectStore } from '../../canvas/projectStore'
import { useLibraryStore } from '../store'

/** 作品回到它出自的对话项目：先按 id 找到项目（本机没有就从云端取），打开后离开资产页。 */
export async function openWorkProject(projectId: string): Promise<boolean> {
  try {
    const project = await useCanvasProjectStore.getState().resolve(projectId)
    const opened = await useAgentStore.getState().selectProject(project.id)
    if (!opened) return false
    useStore.getState().setDetailTaskId(null)
    useStore.getState().setAppMode('canvas')
    useLibraryStore.getState().leaveLibraryPage()
    return true
  } catch {
    useStore.getState().showToast(i18next.t('project.routeUnavailable', { ns: 'canvas' }), 'error')
    return false
  }
}

import type { AgentSurface } from '@image-playground/shared'
import { useShownAgentSurface } from '../../canvas/lib/canvasView'
import { projectExperience } from '../../canvas/lib/projectRepository'
import { useCanvasProjectStore } from '../../canvas/projectStore'

/**
 * 当前项目此刻按哪种模式说话，`/` 菜单据此取技能清单。与发话时（`turnSubmission`）同一规则：
 * 只有画布入口的项目才可能是画布模式，视图还没挂上时按项目的默认视图算。
 */
export function useActiveAgentSurface(): AgentSurface {
  const project = useCanvasProjectStore((state) =>
    state.projects.find((one) => one.id === state.activeId),
  )
  const canvasEntry = project ? projectExperience(project) === 'canvas' : false
  const surface = useShownAgentSurface(project?.id, canvasEntry ? 'canvas' : 'chat')
  return canvasEntry ? surface : 'agent'
}

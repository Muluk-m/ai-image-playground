import { currentCanvasWorkspace, openCurrentProject } from '../../features/canvas/lib/activeProject'
import type { CanvasWorkspace } from '../../features/canvas/lib/workspaces'

/** 进画布：读目录、把当前项目摆上来、等它的画布读完盘。用例起手就这一句。 */
export async function openCanvas(): Promise<CanvasWorkspace> {
  await openCurrentProject()
  const workspace = currentCanvasWorkspace()
  await workspace.ready.catch(() => {})
  return workspace
}

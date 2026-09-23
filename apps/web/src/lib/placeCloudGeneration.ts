import {
  type GenerationDetail,
  type GenerationImage,
  projectArtifactId,
} from '@image-playground/shared'
import { currentCanvasWorkspace } from '../features/canvas/lib/activeProject'
import { currentCanvasProject } from '../features/canvas/projectStore'
import { useStore } from '../store'
import { accountScope } from './authScope'

/** Explicit history placement targets the project selected at the click, never a later project. */
export async function placeCloudGeneration(
  detail: GenerationDetail,
  image: GenerationImage,
  signal: AbortSignal,
) {
  const sameAccount = accountScope()
  const workspace = currentCanvasWorkspace()
  const projectId = currentCanvasProject()?.id
  const isCurrent = () =>
    !signal.aborted &&
    sameAccount() &&
    currentCanvasWorkspace() === workspace &&
    currentCanvasProject()?.id === projectId
  const artifactId = image.artifactId ?? projectArtifactId(detail.id, image.index)
  await workspace.ready
  if (!isCurrent()) return
  if (workspace.getSnapshot().loadFailed) throw new Error('project_unavailable')
  const result = await workspace.sink.place(
    [{ artifactId, taskId: detail.id, name: detail.prompt, dataUrl: `aip-media:${image.mediaId}` }],
    { isCurrent },
  )
  if (!isCurrent()) return
  if (result !== 'placed') throw new Error('project_not_ready')
  if (!(await workspace.flush())) throw new Error('save_failed')
  if (!isCurrent()) return
  workspace.sink.focus([artifactId])
  useStore.getState().setAppMode('canvas')
}

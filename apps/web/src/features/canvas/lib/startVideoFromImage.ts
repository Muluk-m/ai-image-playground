import { i18next } from '../../../i18n'
import { ensureImageCached, useStore } from '../../../store'
import { useAgentStore } from '../../agent/store'
import { useLibraryStore } from '../../library/store'
import { useCanvasComposer } from '../composerStore'
import { currentCanvasProject } from '../projectStore'
import { projectExperience } from './projectRepository'

/** 从任意画布用图片生成视频；从对话进入时才新建画布，保留原会话。 */
export async function startVideoFromImage(imageId: string): Promise<void> {
  const main = useStore.getState()
  const dataUrl = await ensureImageCached(imageId)
  // 图不在了就留在原处提示，别先把用户正看着的浮层关掉。
  if (!dataUrl) {
    main.showToast(i18next.t('toast.imageMissingForCanvas', { ns: 'store' }), 'error')
    return
  }
  const project = currentCanvasProject()
  if (!project || projectExperience(project) !== 'canvas') {
    if (!(await useAgentStore.getState().createProject(undefined, true, 'canvas'))) return
    main.showToast(i18next.t('toast.videoCanvasOpened', { ns: 'store' }), 'success')
  }
  main.setLightboxImageId(null)
  main.setDetailTaskId(null)
  useLibraryStore.getState().leaveLibraryPage()
  useStore.getState().queueCanvasImages([dataUrl])
  useCanvasComposer.getState().requestVideo()
  if (useStore.getState().appMode !== 'canvas') useStore.getState().setAppMode('canvas')
}

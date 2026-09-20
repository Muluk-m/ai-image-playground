import { i18next } from '../../../i18n'
import { ensureImageCached, useStore } from '../../../store'
import { useAgentStore } from '../../agent/store'
import { useLibraryStore } from '../../library/store'
import { useCanvasComposer } from '../composerStore'
import { currentCanvasProject } from '../projectStore'

/**
 * 全局的「生成视频 / 用作首帧」：把图放上一张视频画布（放完即选中）。画布类型建后不可改，
 * 所以当前不是视频画布时先开一张新的，再把图带过去。入口挂在全局，不知道自己浮在哪个面上，
 * 所以三个浮层一起关。
 */
export async function startVideoFromImage(imageId: string): Promise<void> {
  const main = useStore.getState()
  const dataUrl = await ensureImageCached(imageId)
  // 图不在了就留在原处提示，别先把用户正看着的浮层关掉。
  if (!dataUrl) {
    main.showToast(i18next.t('toast.imageMissingForCanvas', { ns: 'store' }), 'error')
    return
  }
  if (currentCanvasProject()?.kind !== 'video') {
    if (!(await useAgentStore.getState().createProject('video'))) return
    main.showToast(i18next.t('toast.videoCanvasOpened', { ns: 'store' }), 'success')
  }
  main.setLightboxImageId(null)
  main.setDetailTaskId(null)
  useLibraryStore.getState().leaveLibraryPage()
  useStore.getState().queueCanvasImages([dataUrl])
  useCanvasComposer.getState().requestVideo()
  if (useStore.getState().appMode !== 'canvas') useStore.getState().setAppMode('canvas')
}

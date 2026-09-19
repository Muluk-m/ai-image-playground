import { i18next } from '../../../i18n'
import { ensureImageCached, useStore } from '../../../store'
import { useLibraryStore } from '../../library/store'
import { useCanvasComposer } from '../composerStore'

/**
 * 全局的「生成视频 / 用作首帧」：把图放上当前画布（放完即选中），再切到视频入口。
 * 生成类型由入口决定，所以这里只切入口、不再另设一个「下一轮按视频」的标记。
 * 入口挂在全局，不知道自己浮在哪个面上，所以三个浮层一起关。
 */
export async function startVideoFromImage(imageId: string): Promise<void> {
  const main = useStore.getState()
  const dataUrl = await ensureImageCached(imageId)
  // 图不在了就留在原处提示，别先把用户正看着的浮层关掉。
  if (!dataUrl) {
    main.showToast(i18next.t('toast.imageMissingForCanvas', { ns: 'store' }), 'error')
    return
  }
  main.setLightboxImageId(null)
  main.setDetailTaskId(null)
  useLibraryStore.getState().closePanel()
  main.queueCanvasImages([dataUrl])
  main.setAppMode('video')
}

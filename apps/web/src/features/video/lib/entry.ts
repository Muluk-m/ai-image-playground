import { useStore } from '../../../store'
import { useLibraryStore } from '../../library/store'
import { useVideoStore } from '../store'

/** 右键菜单挂在全局，不知道自己浮在哪个面上，所以三个浮层一起关。 */
export function startVideoFromImage(imageId: string): void {
  useVideoStore.getState().useAsFirstFrame(imageId)
  const main = useStore.getState()
  main.setAppMode('video')
  main.setLightboxImageId(null)
  main.setDetailTaskId(null)
  useLibraryStore.getState().closePanel()
}

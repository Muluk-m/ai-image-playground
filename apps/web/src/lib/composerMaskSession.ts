import { useStore } from '../store'
import type { MaskEditorSession } from '../types'
import { replaceMaskTargetImage } from './maskPreprocess'

/**
 * 工作台输入框的遮罩会话：遮罩落在主 store 的草稿上，被遮的那张输入图换成编辑器
 * 对齐过的副本。遮罩编辑器本身不再认识这套状态——它只认会话，所以智能体输入框
 * 能拿同一台编辑器把遮罩存进自己的草稿。
 */
export function composerMaskSession(imageId: string): MaskEditorSession {
  const { maskDraft } = useStore.getState()
  const existing = maskDraft?.targetImageId === imageId ? maskDraft.maskDataUrl : null
  return {
    maskDataUrl: existing,
    keepSemantics: false,
    // 还没画过就没什么可移除的，按钮也不该出现。
    ...(existing ? { onRemove: () => useStore.getState().clearMaskDraft() } : {}),
    onSave: ({ maskDataUrl, targetImageId, targetDataUrl }) => {
      const store = useStore.getState()
      store.replaceInputImages(
        replaceMaskTargetImage(store.inputImages, imageId, {
          id: targetImageId,
          dataUrl: targetDataUrl,
        }),
        { equivalentImageIds: { [imageId]: targetImageId } },
      )
      store.setMaskDraft({ targetImageId, maskDataUrl, updatedAt: Date.now() })
    },
  }
}

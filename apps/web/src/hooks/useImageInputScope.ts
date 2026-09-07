import { useLibraryStore } from '../features/library/store'
import { type AppMode, useStore } from '../store'

/** 谁在接拖入与粘贴的图片：三个模式各算一档，素材面板另算一档。 */
export type ImageInputScope = AppMode | 'library'

export function useImageInputScope(): ImageInputScope {
  const appMode = useStore((s) => s.appMode)
  // 素材面板是模态，打开着就该由它收图，身后的模式让位。
  const libraryTakesOver = useLibraryStore((s) => s.panelOpen && s.tab === 'assets')
  return libraryTakesOver ? 'library' : appMode
}

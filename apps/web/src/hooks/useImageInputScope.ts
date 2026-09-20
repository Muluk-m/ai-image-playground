import { useLibraryStore } from '../features/library/store'
import { type AppMode, useStore } from '../store'

/** 谁在接拖入与粘贴的图片：每个入口各算一档，素材入口另算一档。 */
export type ImageInputScope = AppMode | 'library'

export function useImageInputScope(): ImageInputScope {
  const appMode = useStore((s) => s.appMode)
  // 素材页自己就是落点，图片存成素材而不是进输入框。
  const libraryTakesOver = useLibraryStore((s) => s.onLibraryPage && s.tab === 'assets')
  return libraryTakesOver ? 'library' : appMode
}

import { useLibraryStore } from '../features/library/store'
import { type AppMode, useStore } from '../store'

/** 谁在接拖入与粘贴的图片：每个入口各算一档，素材入口另算一档。 */
export type ImageInputScope = AppMode | 'library'

export function useImageInputScope(): ImageInputScope {
  const appMode = useStore((s) => s.appMode)
  const tab = useLibraryStore((s) => (s.onLibraryPage ? s.tab : null))
  // 素材页自己就是落点，图片存成素材；作品页底下有输入框，图片进输入框。
  if (tab === 'assets') return 'library'
  if (tab === 'works') return 'image'
  return appMode
}

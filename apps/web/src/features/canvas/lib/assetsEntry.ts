import { create } from 'zustand'
import type { CanvasAssetItem } from './canvasAssets'
import type { CanvasAssetScope } from './useCanvasAssets'

type Media = CanvasAssetItem['media']

/**
 * 画布「资产」入口：按钮在全局顶栏（积分左边），弹窗由画布自己渲染。
 * 画布挂着时 available 为真；页签和项目范围在关掉弹窗后保留，下次打开还是上次那页。
 */
interface CanvasAssetsEntryState {
  readonly available: boolean
  readonly open: boolean
  readonly media: Media
  readonly scope: CanvasAssetScope
  setAvailable(available: boolean): void
  setOpen(open: boolean): void
  setMedia(media: Media): void
  setScope(scope: CanvasAssetScope): void
}

export const useCanvasAssetsEntry = create<CanvasAssetsEntryState>((set) => ({
  available: false,
  open: false,
  media: 'image',
  scope: 'project',
  setAvailable: (available) => set(available ? { available } : { available, open: false }),
  setOpen: (open) => set({ open }),
  setMedia: (media) => set({ media }),
  setScope: (scope) => set({ scope }),
}))

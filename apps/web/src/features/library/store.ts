import { create } from 'zustand'
import { ensureImageCached, useStore } from '../../store'
import { assetStore } from './lib/assetStore'
import type { AssetRecord } from './types'

export type LibraryTab = 'assets' | 'templates'

export interface LibraryState {
  panelOpen: boolean
  tab: LibraryTab
  searchKeyword: string
  assets: AssetRecord[]
  /** 正在为它取名的图片 id，null 表示没有在存素材。 */
  namingImageId: string | null

  openPanel: () => void
  closePanel: () => void
  setTab: (tab: LibraryTab) => void
  setSearch: (keyword: string) => void
  startNaming: (imageId: string) => void
  cancelNaming: () => void

  loadAssets: () => Promise<void>
  saveAsset: (imageId: string, name: string) => Promise<void>
  renameAsset: (id: string, name: string) => Promise<void>
  deleteAsset: (id: string) => Promise<void>
  /** 返回该素材图在参考图条里的序号；已在条里则复用原序号，附加失败返回 null。 */
  attachAsset: (id: string) => Promise<number | null>
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  panelOpen: false,
  tab: 'assets',
  searchKeyword: '',
  assets: [],
  namingImageId: null,

  openPanel: () => {
    set({ panelOpen: true })
    void get().loadAssets()
  },
  closePanel: () => set({ panelOpen: false }),
  setTab: (tab) => set({ tab }),
  setSearch: (searchKeyword) => set({ searchKeyword }),
  startNaming: (namingImageId) => set({ namingImageId }),
  cancelNaming: () => set({ namingImageId: null }),

  loadAssets: async () => {
    set({ assets: await assetStore.list() })
  },

  saveAsset: async (imageId, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const now = Date.now()
    const asset: AssetRecord = {
      id: crypto.randomUUID(),
      name: trimmed,
      imageId,
      createdAt: now,
      lastUsedAt: now,
    }
    await assetStore.put(asset)
    set((s) => ({ assets: [...s.assets, asset], namingImageId: null }))
    useStore.getState().showToast('已存为素材', 'success')
  },

  renameAsset: async (id, name) => {
    const trimmed = name.trim()
    const asset = get().assets.find((a) => a.id === id)
    if (!trimmed || !asset) return
    await writeAsset(set, { ...asset, name: trimmed })
  },

  deleteAsset: async (id) => {
    await assetStore.remove(id)
    set((s) => ({ assets: s.assets.filter((a) => a.id !== id) }))
  },

  attachAsset: async (id) => {
    const asset = get().assets.find((a) => a.id === id)
    if (!asset) return null
    const main = useStore.getState()
    const dataUrl = await ensureImageCached(asset.imageId)
    if (!dataUrl) {
      main.showToast('素材图片已丢失', 'error')
      return null
    }
    main.addInputImage({ id: asset.imageId, dataUrl })
    await writeAsset(set, { ...asset, lastUsedAt: Date.now() })
    const index = useStore.getState().inputImages.findIndex((img) => img.id === asset.imageId)
    return index >= 0 ? index : null
  },
}))

async function writeAsset(
  set: (updater: (state: LibraryState) => Partial<LibraryState>) => void,
  asset: AssetRecord,
): Promise<void> {
  await assetStore.put(asset)
  set((s) => ({ assets: s.assets.map((a) => (a.id === asset.id ? asset : a)) }))
}

/** 面板列表：按名字过滤，最近用过的排在前面。 */
export function selectVisibleAssets(state: LibraryState): AssetRecord[] {
  const keyword = state.searchKeyword.trim().toLowerCase()
  return state.assets
    .filter((asset) => !keyword || asset.name.toLowerCase().includes(keyword))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

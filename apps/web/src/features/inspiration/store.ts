import { create } from 'zustand'
import { readCache, writeCache } from './lib/cache'
import { fetchRemoteManifest, resolveRemoteManifestUrl } from './lib/fetchManifest'
import type { InspirationItem } from './types'

const REMOTE_TTL_MS = 5 * 60 * 1000

export type InspirationLoadStatus = 'idle' | 'loading-remote' | 'ready' | 'error'
/** UI 上的 provider 分组：all = 不过滤；openai-compat = GPT 系；gemini = Nano Banana 系 */
export type InspirationProviderFilter = 'all' | 'openai-compat' | 'gemini'

export interface InspirationState {
  items: InspirationItem[]
  categories: string[]
  status: InspirationLoadStatus
  remoteError: string | null

  panelOpen: boolean
  selectedProvider: InspirationProviderFilter
  selectedCategory: string | null
  searchKeyword: string
  detailItemId: string | null

  loadRemote: (signal?: AbortSignal) => Promise<void>
  setRemoteItems: (items: InspirationItem[], categories?: string[]) => void
  setRemoteError: (msg: string | null) => void
  setStatus: (status: InspirationLoadStatus) => void

  openPanel: () => void
  closePanel: () => void
  setProvider: (provider: InspirationProviderFilter) => void
  setCategory: (category: string | null) => void
  setSearch: (keyword: string) => void
  showDetail: (id: string) => void
  closeDetail: () => void
}

function deriveCategories(items: InspirationItem[], explicit?: string[]): string[] {
  if (explicit?.length) return explicit
  const set = new Set<string>()
  for (const item of items) {
    if (item.category) set.add(item.category)
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

export const useInspirationStore = create<InspirationState>((set, get) => ({
  items: [],
  categories: [],
  status: 'idle',
  remoteError: null,

  panelOpen: false,
  selectedProvider: 'all',
  selectedCategory: null,
  searchKeyword: '',
  detailItemId: null,

  loadRemote: async (signal) => {
    const url = resolveRemoteManifestUrl()
    if (!url) {
      set({ status: 'ready' })
      return
    }

    const cached = readCache()
    if (cached && Date.now() - cached.storedAt < REMOTE_TTL_MS) {
      get().setRemoteItems(cached.manifest.items, cached.manifest.categories)
    }

    set({ status: 'loading-remote' })
    try {
      const manifest = await fetchRemoteManifest(url, signal)
      writeCache(manifest)
      get().setRemoteItems(manifest.items, manifest.categories)
      set({ status: 'ready', remoteError: null })
    } catch (err) {
      if (signal?.aborted) return
      const msg = err instanceof Error ? err.message : String(err)
      if (cached) {
        get().setRemoteItems(cached.manifest.items, cached.manifest.categories)
      }
      set({ status: 'error', remoteError: msg })
    }
  },

  setRemoteItems: (items, categories) => {
    set({
      items,
      categories: deriveCategories(items, categories),
      remoteError: null,
    })
  },

  setRemoteError: (remoteError) => set({ remoteError }),
  setStatus: (status) => set({ status }),

  openPanel: () => {
    set({ panelOpen: true })
    // 首次开面板才拉远程清单（872KB）；之后 5 分钟内由 localStorage cache 兜底。
    // 不开面板的会话完全免下载。
    void get().loadRemote()
  },
  closePanel: () => set({ panelOpen: false, detailItemId: null }),
  setProvider: (selectedProvider) => set({ selectedProvider, selectedCategory: null }),
  setCategory: (selectedCategory) => set({ selectedCategory }),
  setSearch: (searchKeyword) => set({ searchKeyword }),
  showDetail: (detailItemId) => set({ detailItemId }),
  closeDetail: () => set({ detailItemId: null }),
}))

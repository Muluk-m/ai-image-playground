import { create } from 'zustand'
import type { InspirationItem, InspirationItemWithSource, InspirationManifest } from './types'
import builtinManifestJson from './data/builtin.json'
import { fetchRemoteManifest, resolveRemoteManifestUrl } from './lib/fetchManifest'
import { readCache, writeCache } from './lib/cache'

const builtinManifest = builtinManifestJson as unknown as InspirationManifest

const REMOTE_TTL_MS = 5 * 60 * 1000

export type InspirationLoadStatus = 'idle' | 'loading-remote' | 'ready' | 'error'

export interface InspirationState {
  items: InspirationItemWithSource[]
  categories: string[]
  status: InspirationLoadStatus
  remoteError: string | null

  panelOpen: boolean
  selectedCategory: string | null
  searchKeyword: string
  detailItemId: string | null

  loadBuiltin: () => void
  loadRemote: (signal?: AbortSignal) => Promise<void>
  setRemoteItems: (items: InspirationItem[]) => void
  setRemoteError: (msg: string | null) => void
  setStatus: (status: InspirationLoadStatus) => void

  openPanel: () => void
  closePanel: () => void
  setCategory: (category: string | null) => void
  setSearch: (keyword: string) => void
  showDetail: (id: string) => void
  closeDetail: () => void
}

function deriveCategories(items: InspirationItemWithSource[], explicit?: string[]): string[] {
  if (explicit?.length) return explicit
  const set = new Set<string>()
  for (const item of items) {
    if (item.category) set.add(item.category)
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

function withSource<T extends InspirationItem>(items: T[], source: 'builtin' | 'remote'): InspirationItemWithSource[] {
  return items.map((item) => ({ ...item, source }))
}

export const useInspirationStore = create<InspirationState>((set, get) => ({
  items: [],
  categories: [],
  status: 'idle',
  remoteError: null,

  panelOpen: false,
  selectedCategory: null,
  searchKeyword: '',
  detailItemId: null,

  loadBuiltin: () => {
    const items = withSource(builtinManifest.items, 'builtin')
    set({
      items,
      categories: deriveCategories(items, builtinManifest.categories),
    })
  },

  loadRemote: async (signal) => {
    const url = resolveRemoteManifestUrl()
    if (!url) {
      // 远程被显式禁用（env 设为空串）
      set({ status: 'ready' })
      return
    }

    // 缓存预热：若在 TTL 内，先用缓存合并，再后台刷新
    const cached = readCache()
    if (cached && Date.now() - cached.storedAt < REMOTE_TTL_MS) {
      get().setRemoteItems(cached.manifest.items)
    }

    set({ status: 'loading-remote' })
    try {
      const manifest = await fetchRemoteManifest(url, signal)
      writeCache(manifest)
      get().setRemoteItems(manifest.items)
      set({ status: 'ready', remoteError: null })
    } catch (err) {
      if (signal?.aborted) return
      const msg = err instanceof Error ? err.message : String(err)
      // 失败时若仍有 cache，保留显示
      if (cached) {
        get().setRemoteItems(cached.manifest.items)
      }
      set({ status: 'error', remoteError: msg })
    }
  },

  setRemoteItems: (remoteItems) => {
    const builtinItems = builtinManifest.items
    const map = new Map<string, InspirationItemWithSource>()
    for (const item of builtinItems) map.set(item.id, { ...item, source: 'builtin' })
    for (const item of remoteItems) map.set(item.id, { ...item, source: 'remote' })
    const merged = Array.from(map.values())
    set({
      items: merged,
      categories: deriveCategories(merged, builtinManifest.categories),
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
  setCategory: (selectedCategory) => set({ selectedCategory }),
  setSearch: (searchKeyword) => set({ searchKeyword }),
  showDetail: (detailItemId) => set({ detailItemId }),
  closeDetail: () => set({ detailItemId: null }),
}))

/**
 * 启动期只加载内置（同步、来自 bundle，几乎免费）。
 * 远程清单（872KB）延迟到用户首次开「灵感」面板时再拉，避免 90% 不开面板的会话白下载。
 */
export function initInspirationStore() {
  const state = useInspirationStore.getState()
  if (state.items.length === 0) {
    state.loadBuiltin()
  }
}

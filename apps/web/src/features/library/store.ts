import { create } from 'zustand'
import { API_MAX_IMAGES, MAX_INPUT_IMAGES_MESSAGE } from '../../lib/inputImageLimit'
import { ensureImageCached, useStore } from '../../store'
import { assetStore } from './lib/assetStore'
import { templateStore } from './lib/templateStore'
import {
  collectTemplateAssetIds,
  matchTemplatesByName,
  pickTemplateParams,
  remapTemplateMentions,
} from './lib/templates'
import type { AssetRecord, TemplateRecord } from './types'

export type LibraryTab = 'assets' | 'templates'

export interface LibraryState {
  panelOpen: boolean
  tab: LibraryTab
  searchKeyword: string
  assets: AssetRecord[]
  templates: TemplateRecord[]
  /** 正在为它取名的图片 id，null 表示没有在存素材。 */
  namingImageId: string | null
  /** 正在为当前 composer 状态取模板名。 */
  namingTemplate: boolean

  openPanel: () => void
  closePanel: () => void
  setTab: (tab: LibraryTab) => void
  setSearch: (keyword: string) => void
  startNaming: (imageId: string) => void
  cancelNaming: () => void
  startNamingTemplate: () => void
  cancelNamingTemplate: () => void

  loadAssets: () => Promise<void>
  saveAsset: (imageId: string, name: string) => Promise<void>
  renameAsset: (id: string, name: string) => Promise<void>
  deleteAsset: (id: string) => Promise<void>
  /** 返回该素材图在参考图条里的序号；已在条里则复用原序号，附加失败返回 null。 */
  attachAsset: (id: string) => Promise<number | null>

  loadTemplates: () => Promise<void>
  saveTemplate: (name: string) => Promise<void>
  renameTemplate: (id: string, name: string) => Promise<void>
  deleteTemplate: (id: string) => Promise<void>
  /** 当前提示词非空时先询问是否覆盖，确认后才写入。 */
  applyTemplate: (id: string) => Promise<void>
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  panelOpen: false,
  tab: 'assets',
  searchKeyword: '',
  assets: [],
  templates: [],
  namingImageId: null,
  namingTemplate: false,

  openPanel: () => {
    set({ panelOpen: true })
    void get().loadAssets()
    void get().loadTemplates()
  },
  closePanel: () => set({ panelOpen: false }),
  setTab: (tab) => set({ tab }),
  setSearch: (searchKeyword) => set({ searchKeyword }),
  startNaming: (namingImageId) => set({ namingImageId }),
  cancelNaming: () => set({ namingImageId: null }),
  startNamingTemplate: () => set({ namingTemplate: true }),
  cancelNamingTemplate: () => set({ namingTemplate: false }),

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
    if (!hasRoomForImages(main.inputImages, [asset.imageId])) {
      main.showToast(MAX_INPUT_IMAGES_MESSAGE, 'error')
      return null
    }
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

  loadTemplates: async () => {
    set({ templates: await templateStore.list() })
  },

  saveTemplate: async (name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const main = useStore.getState()
    const now = Date.now()
    const template: TemplateRecord = {
      id: crypto.randomUUID(),
      name: trimmed,
      prompt: main.prompt,
      assetIds: collectTemplateAssetIds(main.prompt, main.inputImages, get().assets),
      params: pickTemplateParams(main.params),
      createdAt: now,
      lastUsedAt: now,
    }
    await templateStore.put(template)
    set((s) => ({ templates: [...s.templates, template], namingTemplate: false }))
    main.showToast('已存为模板', 'success')
  },

  renameTemplate: async (id, name) => {
    const trimmed = name.trim()
    const template = get().templates.find((t) => t.id === id)
    if (!trimmed || !template) return
    await writeTemplate(set, { ...template, name: trimmed })
  },

  deleteTemplate: async (id) => {
    await templateStore.remove(id)
    set((s) => ({ templates: s.templates.filter((t) => t.id !== id) }))
  },

  applyTemplate: async (id) => {
    const template = get().templates.find((t) => t.id === id)
    if (!template) return
    const main = useStore.getState()

    if (main.prompt.trim()) {
      main.setConfirmDialog({
        title: '替换当前输入？',
        message: `将以模板「${template.name}」的提示词、参考图与参数覆盖当前输入。`,
        confirmText: '替换并套用',
        cancelText: '取消',
        showCancel: true,
        tone: 'warning',
        action: () => void writeTemplateIntoComposer(set, get, template),
      })
      return
    }
    await writeTemplateIntoComposer(set, get, template)
  },
}))

type LibrarySet = (updater: (state: LibraryState) => Partial<LibraryState>) => void

async function writeAsset(set: LibrarySet, asset: AssetRecord): Promise<void> {
  await assetStore.put(asset)
  set((s) => ({ assets: s.assets.map((a) => (a.id === asset.id ? asset : a)) }))
}

async function writeTemplate(set: LibrarySet, template: TemplateRecord): Promise<void> {
  await templateStore.put(template)
  set((s) => ({ templates: s.templates.map((t) => (t.id === template.id ? template : t)) }))
}

function hasRoomForImages(
  inputImages: Array<{ id: string }>,
  imageIds: Array<string | null>,
): boolean {
  const missing = new Set(
    imageIds.filter(
      (imageId): imageId is string =>
        Boolean(imageId) && !inputImages.some((image) => image.id === imageId),
    ),
  )
  return inputImages.length + missing.size <= API_MAX_IMAGES
}

async function writeTemplateIntoComposer(
  set: LibrarySet,
  get: () => LibraryState,
  template: TemplateRecord,
): Promise<void> {
  const main = useStore.getState()
  const assetsById = new Map(get().assets.map((asset) => [asset.id, asset]))
  // 素材已被删除的位记 null，套用仍要成功，那一处引用降级为「已移除」。
  const imageIdsByOldIndex = template.assetIds.map(
    (assetId) => (assetId && assetsById.get(assetId)?.imageId) ?? null,
  )

  if (!hasRoomForImages(main.inputImages, imageIdsByOldIndex)) {
    main.showToast(MAX_INPUT_IMAGES_MESSAGE, 'error')
    return
  }

  for (const imageId of new Set(imageIdsByOldIndex.filter((id) => id !== null))) {
    if (useStore.getState().inputImages.some((image) => image.id === imageId)) continue
    const dataUrl = await ensureImageCached(imageId)
    if (dataUrl) main.addInputImage({ id: imageId, dataUrl })
  }

  main.setPrompt(
    remapTemplateMentions(template.prompt, imageIdsByOldIndex, useStore.getState().inputImages),
  )
  main.setParams(template.params)
  await writeTemplate(set, { ...template, lastUsedAt: Date.now() })
  set(() => ({ panelOpen: false }))
}

/** 面板列表：按名字过滤，最近用过的排在前面。 */
export function selectVisibleAssets(state: LibraryState): AssetRecord[] {
  const keyword = state.searchKeyword.trim().toLowerCase()
  return state.assets
    .filter((asset) => !keyword || asset.name.toLowerCase().includes(keyword))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

export function selectVisibleTemplates(state: LibraryState): TemplateRecord[] {
  return matchTemplatesByName(state.templates, state.searchKeyword)
}

import { create } from 'zustand'
import { describeError, i18next } from '../../i18n'
import { ensureAssetImage } from '../../lib/sync/assetImages'
import { ensureImageCached, storeImageFromFile, useStore } from '../../store'
import { DEFAULT_PARAMS, type InputImage } from '../../types'
import { assetStore } from './lib/assetStore'
import { lookStore } from './lib/lookStore'
import { templateStore } from './lib/templateStore'
import {
  collectTemplateAssetIds,
  matchTemplatesByName,
  pickTemplateParams,
  remapTemplateMentions,
} from './lib/templates'
import {
  type AssetBackground,
  type AssetKind,
  type AssetRecord,
  type AssetView,
  assetCoverImageId,
  type LookPurpose,
  type LookRecord,
  type PendingAssetName,
  type TemplateRecord,
} from './types'

/**
 * 资产页的四个页签。作品在创作页、灵感另一个入口，都不在里面。
 * `prompts` 就是旧「模板」那一页，存储名与同步 kind 仍是 `templates`。
 */
export type LibraryTab = 'projects' | 'assets' | 'prompts' | 'looks'

type OnAssetSaved = (asset: AssetRecord) => void

/** 新建素材时要带的东西；`group` 让一次多选落成一条多视角素材而不是逐张取名。 */
export interface ImportAssetOptions {
  group?: boolean
  kind?: AssetKind
  background?: AssetBackground
  name?: string
  onSaved?: OnAssetSaved
}

/** 落库用的素材内容。带 `id` 就是就地更新那一条，`createdAt` 不动。 */
export interface AssetRecordInput {
  id?: string
  name: string
  kind?: AssetKind
  background?: AssetBackground
  views: AssetView[]
}

/** 落库用的模板内容。带 `id` 就是就地更新那一条（调试到满意再更新同一条）。 */
export type LookRecordInput = Omit<LookRecord, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt'> & {
  id?: string
}

export interface LibraryState {
  /** 库页是否正在主区里;由 `LibraryPage` 挂载时登记。 */
  onLibraryPage: boolean
  tab: LibraryTab
  searchKeyword: string
  assets: AssetRecord[]
  templates: TemplateRecord[]
  looks: LookRecord[]
  /** 打开的模板详情，null 表示停在列表。 */
  detailTemplateId: string | null
  /** 等待取名的图片队列，头一条就是取名对话框正在问的那张。 */
  pendingAssetNames: PendingAssetName[]
  /** 正在为当前 composer 状态取模板名。 */
  namingTemplate: boolean

  enterLibraryPage: (tab?: LibraryTab) => void
  /** 页签切换:搜索词跟着页签走,换一类料不带着上一类的关键词。 */
  setTab: (tab: LibraryTab) => void
  /** 去「资产 → 项目」：画布项目是资产的一部分，不另占一个入口。 */
  openProjects: () => void
  leaveLibraryPage: () => void
  setSearch: (keyword: string) => void
  openTemplateDetail: (id: string) => void
  closeTemplateDetail: () => void
  startNaming: (imageId: string, defaultName?: string, onSaved?: OnAssetSaved) => void
  cancelNaming: () => void
  startNamingTemplate: () => void
  cancelNamingTemplate: () => void

  loadAssets: () => Promise<void>
  saveAsset: (imageId: string, name: string) => Promise<void>
  /** 落库一条素材。带 `id` 就是就地更新那一条：`createdAt` 不动，`updatedAt` 前进。 */
  saveAssetRecord: (input: AssetRecordInput) => Promise<AssetRecord>
  renameAsset: (id: string, name: string) => Promise<void>
  deleteAsset: (id: string) => Promise<void>
  /**
   * 存入本地图片文件。默认逐张排进取名队列（一张图一条素材）；
   * `group` 让这一批落成一条多视角素材，第一张是封面。
   */
  importAssetFiles: (files: File[], options?: ImportAssetOptions) => Promise<void>
  /**
   * 附上该素材取得回来的全部视角，返回引用该落在哪一位——封面那一位，封面取不回来时是
   * 第一张取到的视角；已在条里的复用原序号。一张都取不回来、或整组放不下时返回 null。
   */
  attachAsset: (id: string) => Promise<number | null>
  /** 记一次使用。「最近用过」的排序是唯一读者，所以每条附加路径都要过它。 */
  noteAssetUsed: (id: string) => Promise<void>

  loadTemplates: () => Promise<void>
  saveTemplate: (name: string) => Promise<void>
  savePromptTemplate: (name: string, prompt: string) => Promise<void>
  renameTemplate: (id: string, name: string) => Promise<void>
  deleteTemplate: (id: string) => Promise<void>
  /** 当前提示词非空时先询问是否覆盖，确认后才写入。 */
  applyTemplate: (id: string) => Promise<void>

  loadLooks: () => Promise<void>
  /** 落库一条模板。带 `id` 就是就地更新那一条（智能体调试到满意再更新同一条）。 */
  saveLookRecord: (input: LookRecordInput) => Promise<LookRecord>
  renameLook: (id: string, name: string) => Promise<void>
  deleteLook: (id: string) => Promise<void>
  noteLookUsed: (id: string) => Promise<void>
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  onLibraryPage: false,
  tab: 'assets',
  searchKeyword: '',
  assets: [],
  templates: [],
  looks: [],
  detailTemplateId: null,
  pendingAssetNames: [],
  namingTemplate: false,

  enterLibraryPage: (tab) => {
    set((s) => ({ onLibraryPage: true, tab: tab ?? s.tab, searchKeyword: '' }))
    useStore.getState().markLibraryPanelOpened()
  },
  leaveLibraryPage: () => set({ onLibraryPage: false, detailTemplateId: null }),
  setTab: (tab) => set({ tab, searchKeyword: '', detailTemplateId: null }),
  openProjects: () => {
    set({ tab: 'projects', searchKeyword: '', detailTemplateId: null })
    useStore.getState().setAppMode('library')
  },
  setSearch: (searchKeyword) => set({ searchKeyword }),
  openTemplateDetail: (detailTemplateId) => set({ detailTemplateId }),
  closeTemplateDetail: () => set({ detailTemplateId: null }),
  startNaming: (imageId, defaultName = '', onSaved) =>
    set((s) => ({
      pendingAssetNames: [...s.pendingAssetNames, { imageId, defaultName, onSaved }],
    })),
  cancelNaming: () => set((s) => ({ pendingAssetNames: s.pendingAssetNames.slice(1) })),
  startNamingTemplate: () => set({ namingTemplate: true }),
  cancelNamingTemplate: () => set({ namingTemplate: false }),

  loadAssets: async () => {
    set({ assets: await assetStore.list() })
  },

  saveAsset: async (imageId, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const pending = get().pendingAssetNames[0]
    const asset = await get().saveAssetRecord({
      name: trimmed,
      views: [{ imageId, label: 'none', source: 'upload' }],
    })
    set((s) => ({ pendingAssetNames: s.pendingAssetNames.slice(1) }))
    if (pending?.imageId === imageId) pending.onSaved?.(asset)
    useStore.getState().showToast(i18next.t('library:toast.assetSaved'), 'success')
  },

  saveAssetRecord: async (input) => {
    const now = Date.now()
    const existing = input.id ? get().assets.find((a) => a.id === input.id) : undefined
    const asset: AssetRecord = {
      id: input.id ?? crypto.randomUUID(),
      name: input.name.trim(),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.background ? { background: input.background } : {}),
      views: input.views,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt ?? now,
    }
    await assetStore.put(asset)
    set((s) => ({
      assets: existing
        ? s.assets.map((a) => (a.id === asset.id ? asset : a))
        : [...s.assets, asset],
    }))
    return asset
  },

  renameAsset: async (id, name) => {
    const trimmed = name.trim()
    const asset = get().assets.find((a) => a.id === id)
    if (!trimmed || !asset) return
    await writeAsset(set, { ...asset, name: trimmed, updatedAt: Date.now() })
  },

  deleteAsset: async (id) => {
    await assetStore.remove(id)
    set((s) => ({ assets: s.assets.filter((a) => a.id !== id) }))
  },

  attachAsset: async (id) => {
    const asset = get().assets.find((a) => a.id === id)
    if (!asset) return null
    const main = useStore.getState()

    const views = await assetViewImages(asset)
    if (views.length === 0) {
      main.showToast(i18next.t('library:toast.assetImageMissing'), 'error')
      return null
    }
    const before = main.inputImages.length
    // 组里全部视角是一组：整组落地或整组不落，准入与去重都归参考图草稿管。
    const indexes = main.attachInputImages(views)
    if (!indexes) return null

    await writeAsset(set, { ...asset, lastUsedAt: Date.now() })
    // 面板外（composer 的 `@` 菜单）插入的引用胶囊本身就是反馈，再 toast 是噪音。
    if (get().onLibraryPage) {
      const added = useStore.getState().inputImages.length > before
      useStore.getState().setAppMode('image')
      main.showToast(
        added
          ? i18next.t('library:toast.addedToReferences')
          : i18next.t('library:toast.alreadyInReferences'),
        added ? 'success' : 'info',
      )
    }
    // 引用指向封面：一条素材在提示词里只占一个胶囊。封面取不回来时落在第一张取到的视角上。
    return indexes[0] ?? null
  },

  noteAssetUsed: async (id) => {
    const asset = get().assets.find((one) => one.id === id)
    if (asset) await writeAsset(set, { ...asset, lastUsedAt: Date.now() })
  },

  importAssetFiles: async (files, options = {}) => {
    const images = files.filter((f) => f.type.startsWith('image/'))
    const stored: string[] = []
    for (const file of images) {
      try {
        const image = await storeImageFromFile(file, { compress: true })
        if (options.group) stored.push(image.id)
        else get().startNaming(image.id, stripFileExtension(file.name), options.onSaved)
      } catch (e) {
        useStore
          .getState()
          .showToast(
            i18next.t('library:toast.imageAddFailed', { reason: describeError(e) }),
            'error',
          )
      }
    }
    if (!options.group || stored.length === 0) return
    // 一组图就是一条素材：第一张是封面，没给名字就沿用取名队列那条规矩——第一张的文件名。
    const asset = await get().saveAssetRecord({
      name: options.name?.trim() || stripFileExtension(images[0]?.name ?? ''),
      ...(options.kind ? { kind: options.kind } : {}),
      ...(options.background ? { background: options.background } : {}),
      views: stored.map((imageId) => ({
        imageId,
        label: 'none' as const,
        source: 'upload' as const,
      })),
    })
    options.onSaved?.(asset)
    useStore.getState().showToast(i18next.t('library:toast.assetSaved'), 'success')
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
      updatedAt: now,
      lastUsedAt: now,
    }
    await templateStore.put(template)
    set((s) => ({ templates: [...s.templates, template], namingTemplate: false }))
    main.showToast(i18next.t('library:toast.templateSaved'), 'success')
  },

  savePromptTemplate: async (name, prompt) => {
    const trimmed = name.trim()
    if (!trimmed || !prompt.trim()) return
    const now = Date.now()
    const template: TemplateRecord = {
      id: crypto.randomUUID(),
      name: trimmed,
      prompt,
      assetIds: [],
      params: pickTemplateParams(DEFAULT_PARAMS),
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    }
    await templateStore.put(template)
    set((s) => ({ templates: [...s.templates, template] }))
    useStore.getState().showToast(i18next.t('library:toast.promptTemplateSaved'), 'success')
  },

  renameTemplate: async (id, name) => {
    const trimmed = name.trim()
    const template = get().templates.find((t) => t.id === id)
    if (!trimmed || !template) return
    await writeTemplate(set, { ...template, name: trimmed, updatedAt: Date.now() })
  },

  deleteTemplate: async (id) => {
    await templateStore.remove(id)
    set((s) => ({
      templates: s.templates.filter((t) => t.id !== id),
      detailTemplateId: s.detailTemplateId === id ? null : s.detailTemplateId,
    }))
  },

  applyTemplate: async (id) => {
    const template = get().templates.find((t) => t.id === id)
    if (!template) return
    const main = useStore.getState()

    if (main.prompt.trim()) {
      main.setConfirmDialog({
        title: i18next.t('library:template.replaceTitle'),
        message: i18next.t('library:template.replaceMessage', { name: template.name }),
        confirmText: i18next.t('library:template.replaceConfirm'),
        cancelText: i18next.t('action.cancel'),
        showCancel: true,
        tone: 'warning',
        action: () => void writeTemplateIntoComposer(set, get, template),
      })
      return
    }
    await writeTemplateIntoComposer(set, get, template)
  },

  loadLooks: async () => {
    set({ looks: await lookStore.list() })
  },

  saveLookRecord: async (input) => {
    const now = Date.now()
    const existing = input.id ? get().looks.find((one) => one.id === input.id) : undefined
    const look: LookRecord = {
      ...input,
      id: input.id ?? crypto.randomUUID(),
      name: input.name.trim(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt ?? now,
    }
    await lookStore.put(look)
    set((s) => ({
      looks: existing
        ? s.looks.map((one) => (one.id === look.id ? look : one))
        : [...s.looks, look],
    }))
    return look
  },

  renameLook: async (id, name) => {
    const trimmed = name.trim()
    const look = get().looks.find((one) => one.id === id)
    if (!trimmed || !look) return
    await writeLook(set, { ...look, name: trimmed, updatedAt: Date.now() })
  },

  deleteLook: async (id) => {
    await lookStore.remove(id)
    set((s) => ({ looks: s.looks.filter((one) => one.id !== id) }))
  },

  noteLookUsed: async (id) => {
    const look = get().looks.find((one) => one.id === id)
    if (look) await writeLook(set, { ...look, lastUsedAt: Date.now() })
  },
}))

function stripFileExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '')
}

type LibrarySet = (updater: (state: LibraryState) => Partial<LibraryState>) => void

// 「使用」只动 lastUsedAt：改内容的调用方自己带上新的 updatedAt，这里不代劳。
async function writeAsset(set: LibrarySet, asset: AssetRecord): Promise<void> {
  await assetStore.put(asset)
  set((s) => ({ assets: s.assets.map((a) => (a.id === asset.id ? asset : a)) }))
}

async function writeTemplate(set: LibrarySet, template: TemplateRecord): Promise<void> {
  await templateStore.put(template)
  set((s) => ({ templates: s.templates.map((t) => (t.id === template.id ? template : t)) }))
}

async function writeLook(set: LibrarySet, look: LookRecord): Promise<void> {
  await lookStore.put(look)
  set((s) => ({ looks: s.looks.map((one) => (one.id === look.id ? look : one)) }))
}

/**
 * 一条素材的全部视角取成参考图：按 `imageId` 去重、保持组里的顺序（第一张是封面）。
 * 别的设备建的素材图这时才取回来；取不回来的那张跳过——为一张还没同步到的视角把整条
 * 素材都附不上说不过去。生成与智能体两边共用这一条，素材附加只有一种行为。
 */
export async function assetViewImages(asset: AssetRecord): Promise<InputImage[]> {
  const images: InputImage[] = []
  for (const imageId of new Set(asset.views.map((view) => view.imageId))) {
    await ensureAssetImage(imageId)
    const dataUrl = await ensureImageCached(imageId)
    if (dataUrl) images.push({ id: imageId, dataUrl })
  }
  return images
}

async function writeTemplateIntoComposer(
  set: LibrarySet,
  get: () => LibraryState,
  template: TemplateRecord,
): Promise<void> {
  const main = useStore.getState()
  const assetsById = new Map(get().assets.map((asset) => [asset.id, asset]))
  // 素材已被删除的位记 null，套用仍要成功，那一处引用降级为「已移除」。
  const imageIdsByOldIndex = template.assetIds.map((assetId) => {
    const asset = assetId ? assetsById.get(assetId) : undefined
    return asset ? assetCoverImageId(asset) : null
  })

  const covers: InputImage[] = []
  for (const imageId of new Set(imageIdsByOldIndex.filter((id) => id !== null))) {
    // 别的设备建的素材图这时才取回来，取不到才让那一处引用降级为「已移除」。
    await ensureAssetImage(imageId)
    const dataUrl = await ensureImageCached(imageId)
    if (dataUrl) covers.push({ id: imageId, dataUrl })
  }
  // 模板要的素材是一组：放不下就整条不套用，免得留下半条参考图配一句改过的提示词。
  if (!main.attachInputImages(covers)) return

  main.setPrompt(
    remapTemplateMentions(template.prompt, imageIdsByOldIndex, useStore.getState().inputImages),
  )
  main.setParams(template.params)
  await writeTemplate(set, { ...template, lastUsedAt: Date.now() })
  // 套用完就该看见输入框里的结果：详情收起，切回生图入口。
  set(() => ({ detailTemplateId: null }))
  useStore.getState().setAppMode('image')
}

/** 列表：按名字过滤，最近用过的排在前面。 */
export function selectVisibleAssets(state: LibraryState): AssetRecord[] {
  const keyword = state.searchKeyword.trim().toLowerCase()
  return state.assets
    .filter((asset) => !keyword || asset.name.toLowerCase().includes(keyword))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

export function selectVisibleTemplates(state: LibraryState): TemplateRecord[] {
  return matchTemplatesByName(state.templates, state.searchKeyword)
}

export function selectVisibleLooks(state: LibraryState): LookRecord[] {
  const keyword = state.searchKeyword.trim().toLowerCase()
  return state.looks
    .filter((look) => !keyword || look.name.toLowerCase().includes(keyword))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

import { create } from 'zustand'
import type { ToolId, ToolSource } from './lib/tool'

/**
 * 工具箱导进来的一张图。**只活在内存里**：刷新就没了，中间产物也不写 IndexedDB
 * （那张表存 data URL，比二进制还多三成体积，批量处理会把它撑坏）。
 * 图片在工具之间保留：换工具不用重新拖一遍。
 */
export interface ToolboxItem {
  id: string
  name: string
  /** 原图的对象 URL：结果出来之前卡片先显示它。 */
  url: string
  type: string
  size: number
  width: number
  height: number
  /** 这台浏览器解不开（多数浏览器的 HEIC）：卡片直接标出来，不参与处理。 */
  decodable: boolean
}

/** 位图不进 store：它不可序列化，也不该参与 zustand 的相等比较。按 id 放这儿，随条目一起生灭。 */
const bitmaps = new Map<string, ImageBitmap>()

export function toolSource(item: ToolboxItem): ToolSource | null {
  const bitmap = bitmaps.get(item.id)
  if (!bitmap) return null
  return { id: item.id, name: item.name, type: item.type, size: item.size, bitmap }
}

interface ToolboxState {
  items: ToolboxItem[]
  /** 打开的工具；为 null 时主区是目录页。 */
  activeTool: ToolId | null
  add: (files: readonly File[]) => Promise<void>
  remove: (id: string) => void
  clear: () => void
  openTool: (id: ToolId) => void
  closeTool: () => void
}

function releaseItem(item: ToolboxItem): void {
  URL.revokeObjectURL(item.url)
  bitmaps.get(item.id)?.close()
  bitmaps.delete(item.id)
}

export const useToolboxStore = create<ToolboxState>()((set, get) => ({
  items: [],
  activeTool: null,
  // 逐张解码：一次 Promise.all 几十张 4000px 的图会把内存峰值顶上去。
  // `createImageBitmap` 默认按 EXIF 摆正，后面的工具拿到的都是已经正过来的像素。
  add: async (files) => {
    for (const file of files) {
      const id = crypto.randomUUID()
      const base = {
        id,
        name: file.name,
        url: URL.createObjectURL(file),
        type: file.type,
        size: file.size,
      }
      let item: ToolboxItem
      try {
        const bitmap = await createImageBitmap(file)
        bitmaps.set(id, bitmap)
        item = { ...base, width: bitmap.width, height: bitmap.height, decodable: true }
      } catch {
        item = { ...base, width: 0, height: 0, decodable: false }
      }
      set((state) => ({ items: [...state.items, item] }))
    }
  },
  remove: (id) => {
    const item = get().items.find((one) => one.id === id)
    if (item) releaseItem(item)
    set((state) => ({ items: state.items.filter((one) => one.id !== id) }))
  },
  clear: () => {
    for (const item of get().items) releaseItem(item)
    set({ items: [] })
  },
  openTool: (id) => set({ activeTool: id }),
  closeTool: () => set({ activeTool: null }),
}))

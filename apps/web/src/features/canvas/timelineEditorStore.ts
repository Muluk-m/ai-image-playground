import { create } from 'zustand'

/** 正在全屏编辑的时间线。画布（双击）与工具条（「编辑」）都往这里写，编辑器据此挂载。 */
export const useTimelineEditor = create<{
  openId: string | null
  open(id: string): void
  close(): void
}>((set) => ({
  openId: null,
  open: (id) => set({ openId: id }),
  close: () => set({ openId: null }),
}))

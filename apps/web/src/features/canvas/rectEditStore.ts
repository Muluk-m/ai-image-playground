import { create } from 'zustand'

/** 裁切 = 把边往里收，扩图 = 把边往外推。两者是同一个拖拽框，只是夹取方向相反。 */
export type RectEditMode = 'crop' | 'outpaint'

/**
 * 编辑框，坐标是**元素局部显示单位**：`(0,0,width,height)` 正好是原图本身。
 * 裁切时框在原图里面，扩图时框在原图外面，所以 x / y 可以是负数。
 */
export interface EditRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 裁切 / 扩图的拖拽会话。与涂抹会话同理**不进 CanvasDoc**：编辑框是瞬态的，
 * 写进 doc 会被 undo 栈记成一串中间态。
 */
export const useRectEdit = create<{
  mode: RectEditMode | null
  imageId: string | null
  rect: EditRect
  submitting: boolean
  open(mode: RectEditMode, imageId: string, rect: EditRect): void
  close(): void
  setRect(rect: EditRect): void
  setSubmitting(submitting: boolean): void
}>((set) => ({
  mode: null,
  imageId: null,
  rect: { x: 0, y: 0, w: 0, h: 0 },
  submitting: false,
  open: (mode, imageId, rect) => set({ mode, imageId, rect, submitting: false }),
  close: () => set({ mode: null, imageId: null, submitting: false }),
  setRect: (rect) => set({ rect }),
  setSubmitting: (submitting) => set({ submitting }),
}))

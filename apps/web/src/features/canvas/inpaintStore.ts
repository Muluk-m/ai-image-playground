import { create } from 'zustand'
import type { MaskStroke } from './lib/inpaintMask'

/** 局部重绘面板里附的那张参考图。只在会话期间存在，不落画布、不进持久化。 */
export interface InpaintReference {
  readonly dataUrl: string
  readonly name: string
}

/** 笔宽用**屏幕像素**存：画布缩放时手感恒定；转成页面单位是落笔那一刻按相机算的。 */
const DEFAULT_BRUSH_PX = 48
export const MIN_BRUSH_PX = 8
export const MAX_BRUSH_PX = 160

/**
 * 一次局部重绘的涂抹会话。**不进 CanvasDoc**：doc 的快照就是 undo 栈，
 * 把涂抹中间态塞进去会让一次 ⌘Z 把用户正在画的东西撤回来，而且它也不该被持久化。
 */
export const useInpaintSession = create<{
  imageId: string | null
  strokes: MaskStroke[]
  tool: 'brush' | 'eraser'
  brushPx: number
  prompt: string
  reference: InpaintReference | null
  submitting: boolean
  open(imageId: string): void
  close(): void
  setTool(tool: 'brush' | 'eraser'): void
  setBrushPx(px: number): void
  addStroke(stroke: MaskStroke): void
  undo(): void
  clearStrokes(): void
  setPrompt(prompt: string): void
  setReference(reference: InpaintReference | null): void
  setSubmitting(submitting: boolean): void
}>((set) => ({
  imageId: null,
  strokes: [],
  tool: 'brush',
  brushPx: DEFAULT_BRUSH_PX,
  prompt: '',
  reference: null,
  submitting: false,
  // 每次打开都从零起：上一张图的笔画按上一张图的页面坐标算，套到新图上是乱的。
  open: (imageId) =>
    set({ imageId, strokes: [], tool: 'brush', prompt: '', reference: null, submitting: false }),
  close: () => set({ imageId: null, strokes: [], prompt: '', reference: null, submitting: false }),
  setTool: (tool) => set({ tool }),
  setBrushPx: (px) => set({ brushPx: Math.min(MAX_BRUSH_PX, Math.max(MIN_BRUSH_PX, px)) }),
  addStroke: (stroke) => set((state) => ({ strokes: [...state.strokes, stroke] })),
  undo: () => set((state) => ({ strokes: state.strokes.slice(0, -1) })),
  clearStrokes: () => set({ strokes: [] }),
  setPrompt: (prompt) => set({ prompt }),
  setReference: (reference) => set({ reference }),
  setSubmitting: (submitting) => set({ submitting }),
}))

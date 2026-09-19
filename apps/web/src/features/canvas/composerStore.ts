import { create } from 'zustand'

interface CanvasComposerState {
  prompt: string
  setPrompt(prompt: string): void
}

/**
 * 画布生成栏的输入。放在 store 里而不是组件里，是因为视频节点的「重新生成」要把当时的
 * 描述载回这里——生成栏只是它的一个视图。
 *
 * 生成类型不在这里：它由入口决定，见 `lib/generationMode.ts`。
 */
export const useCanvasComposer = create<CanvasComposerState>((set) => ({
  prompt: '',
  setPrompt(prompt) {
    set({ prompt })
  },
}))

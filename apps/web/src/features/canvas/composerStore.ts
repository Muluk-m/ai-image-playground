import { create } from 'zustand'
import { safeLocalStorage } from '../../lib/authScope'

export type CanvasGenerateMode = 'image' | 'video'

/** 生成栏上次停在图片档还是视频档，本机记住。 */
const MODE_STORAGE_KEY = 'canvas.generateMode'

interface CanvasComposerState {
  mode: CanvasGenerateMode
  prompt: string
  setMode(mode: CanvasGenerateMode): void
  setPrompt(prompt: string): void
}

/**
 * 画布生成栏的输入。放在 store 里而不是组件里，是因为视频节点的「重新生成」要把当时的描述
 * 和档位载回这里——生成栏只是它的一个视图。
 */
export const useCanvasComposer = create<CanvasComposerState>((set) => ({
  mode: safeLocalStorage.getItem(MODE_STORAGE_KEY) === 'video' ? 'video' : 'image',
  prompt: '',
  setMode(mode) {
    safeLocalStorage.setItem(MODE_STORAGE_KEY, mode)
    set({ mode })
  },
  setPrompt(prompt) {
    set({ prompt })
  },
}))

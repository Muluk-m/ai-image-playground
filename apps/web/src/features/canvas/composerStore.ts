import { create } from 'zustand'
import { safeLocalStorage } from '../../lib/authScope'

export type CanvasGenerateMode = 'image' | 'video'

/** 生成栏上次停在图片档还是视频档，本机记住。 */
const MODE_STORAGE_KEY = 'canvas.generateMode'

interface CanvasComposerState {
  mode: CanvasGenerateMode
  prompt: string
  /**
   * 有人要求「接下来生成视频」（进入视频入口、从图片发起生成视频）而智能体输入框还没接手。
   * 输入框把自己的轮类型切到视频后清掉它；没有智能体的部署里它留着也无妨。
   */
  agentVideoPending: boolean
  setMode(mode: CanvasGenerateMode): void
  setPrompt(prompt: string): void
  /** 生成栏停到视频档，并让智能体输入框把下一轮预置为视频。 */
  requestVideo(): void
  consumeAgentVideo(): boolean
}

/**
 * 画布生成栏的输入。放在 store 里而不是组件里，是因为视频节点的「重新生成」要把当时的描述
 * 和档位载回这里——生成栏只是它的一个视图。
 */
export const useCanvasComposer = create<CanvasComposerState>((set, get) => ({
  mode: safeLocalStorage.getItem(MODE_STORAGE_KEY) === 'video' ? 'video' : 'image',
  prompt: '',
  agentVideoPending: false,
  setMode(mode) {
    safeLocalStorage.setItem(MODE_STORAGE_KEY, mode)
    set({ mode })
  },
  setPrompt(prompt) {
    set({ prompt })
  },
  requestVideo() {
    safeLocalStorage.setItem(MODE_STORAGE_KEY, 'video')
    set({ mode: 'video', agentVideoPending: true })
  },
  consumeAgentVideo() {
    if (!get().agentVideoPending) return false
    set({ agentVideoPending: false })
    return true
  },
}))

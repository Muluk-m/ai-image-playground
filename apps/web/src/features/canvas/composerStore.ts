import { create } from 'zustand'
import { safeLocalStorage } from '../../lib/authScope'

export type CanvasGenerateMode = 'image' | 'video'

/** 生成栏上次停在图片档还是视频档，本机记住。 */
const MODE_STORAGE_KEY = 'canvas.generateMode'

interface CanvasComposerState {
  mode: CanvasGenerateMode
  prompt: string
  /**
   * 视频入口落地页交接过来的一句话。落地页自己不起轮：画布挂载、工作区就绪之后才发，
   * 这样产物有地方落（智能体的画布 sink 是 CanvasWorkspace 装的）。
   */
  handoffPrompt: string | null
  setMode(mode: CanvasGenerateMode): void
  setPrompt(prompt: string): void
  /** 生成栏停到视频档（本次打开内）。智能体输入框不看它：那边的轮类型由项目的画布类型定。 */
  requestVideo(): void
  /** 落地页提交：记下这句话并把下一轮预置成视频，切到画布后由画布取走。 */
  handOffVideoPrompt(prompt: string): void
  consumeHandoffPrompt(): string | null
}

/**
 * 画布生成栏的输入。放在 store 里而不是组件里，是因为视频节点的「重新生成」要把当时的描述
 * 和档位载回这里——生成栏只是它的一个视图。
 */
export const useCanvasComposer = create<CanvasComposerState>((set, get) => ({
  mode: safeLocalStorage.getItem(MODE_STORAGE_KEY) === 'video' ? 'video' : 'image',
  prompt: '',
  handoffPrompt: null,
  setMode(mode) {
    safeLocalStorage.setItem(MODE_STORAGE_KEY, mode)
    set({ mode })
  },
  setPrompt(prompt) {
    set({ prompt })
  },
  requestVideo() {
    // 预置不算用户的选择，不写进「上次停在哪档」。
    set({ mode: 'video' })
  },
  handOffVideoPrompt(prompt) {
    const trimmed = prompt.trim()
    if (!trimmed) return
    get().requestVideo()
    set({ handoffPrompt: trimmed })
  },
  consumeHandoffPrompt() {
    const prompt = get().handoffPrompt
    if (prompt === null) return null
    set({ handoffPrompt: null })
    return prompt
  },
}))

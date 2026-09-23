import { useStore } from '../../../store'
import type { TaskParams } from '../../../types'
import type { PlacementTarget } from './placement'
import type { RegenRecipe } from './regenRecipe'

/**
 * 当前全局参数的画布任务快照：n 折叠为 1（上游不支持 n，fan-out 在发起层拆成多任务）。
 * spec 构造与重试 / 恢复的兜底统一用它。
 */
export function snapshotParams(): TaskParams {
  return { ...useStore.getState().params, n: 1 }
}

/**
 * 一次画布生成任务的完整描述：人话需求 + 输入图 + 参数快照 + 放置目标。
 * 既是发起入口的参数，也是内存运行态里存的东西（两者本就同形）。
 */
export interface CanvasTaskSpec {
  /** 人话需求（画布文字标注 + 输入框合并）。标注指令样板在发起时才注入，不存这里。 */
  prompt: string
  /** 是否标注模式：发起时决定是否注入「按标注改、输出干净图」指令前缀。 */
  annotated: boolean
  inputImageDataUrls: string[]
  /**
   * 局部重绘的遮罩（不透明 = 保留、透明 = 可重绘），与 `inputImageDataUrls[0]` 逐像素同尺寸。
   * 与输入图一样不持久化：它只为「同会话内重试」而留在内存运行态里。
   */
  maskDataUrl?: string
  /** 二次加工的源图元素 id：处理期间那张卡片上盖遮罩，刷新后也要认得出来。 */
  editSourceId?: string
  /** 二次加工的种类，决定卡片与占位框上写什么。 */
  editKind?: 'inpaint' | 'erase' | 'outpaint' | 'cutout'
  /**
   * 「这张图是怎么来的」的配方，会随结果元素持久化。刷新后运行态没了，靠它重出。
   * 见 `regenRecipe.ts`。
   */
  recipe?: RegenRecipe
  /** 发起时的参数快照（n 已折叠为 1，fan-out 在上层展开为多任务）。 */
  params: TaskParams
  target: PlacementTarget
}

/**
 * 画布任务的内存运行态：持有**不可持久化**的运行时数据（输入图与遮罩的 data URL）。
 * 它是 shape.meta 的**投影**，不是真相源——任何持久的东西以占位框 shape.meta 为准（决策 2）。
 *
 * 存在意义：输入图刻意不写进 shape.meta（决策 2 / 6，避免把数 MB blob 塞进画布持久化），
 * 所以「同会话内失败重试」与「重新生成」需要的原始输入只能放这里；页面刷新后此表清空，
 * 恢复走 resumeQueueImageApi（不重传输入图），重新生成则直接拒绝而不是退化成文生图。
 *
 * 任务成功落图后条目**不删**——重新生成要拿它原样再发一次。代价是几 MB 的 data URL
 * 会留在内存里，所以这里是一张**有界 LRU**：只留最近 RETAINED_TASKS 条，读一次算一次新。
 */
const RETAINED_TASKS = 8
const handles = new Map<string, CanvasTaskSpec>()

export function registerCanvasTask(taskId: string, spec: CanvasTaskSpec): void {
  handles.set(taskId, spec)
  while (handles.size > RETAINED_TASKS) {
    const oldest = handles.keys().next()
    if (oldest.done) break
    handles.delete(oldest.value)
  }
}

export function getCanvasTask(taskId: string): CanvasTaskSpec | undefined {
  const spec = handles.get(taskId)
  // 读一次就挪到队尾：反复重出同一张图时，别让它被后面几次生成挤掉。
  if (spec) {
    handles.delete(taskId)
    handles.set(taskId, spec)
  }
  return spec
}

export function removeCanvasTask(taskId: string): void {
  handles.delete(taskId)
}

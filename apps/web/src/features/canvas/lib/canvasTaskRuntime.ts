import { useStore } from '../../../store'
import type { TaskParams } from '../../../types'
import type { PlacementTarget } from './placement'

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
  /** 发起时的参数快照（n 已折叠为 1，fan-out 在上层展开为多任务）。 */
  params: TaskParams
  target: PlacementTarget
}

/**
 * 画布任务的内存运行态：持有**不可持久化**的运行时数据（输入图 data URL）。
 * 它是 shape.meta 的**投影**，不是真相源——任何持久的东西以占位框 shape.meta 为准（决策 2）。
 *
 * 存在意义：输入图刻意不写进 shape.meta（决策 2 / 6，避免把数 MB blob 塞进画布持久化），
 * 所以「同会话内失败重试」需要的原始输入图只能放这里；页面刷新后此表清空，
 * 恢复走 resumeQueueImageApi（不重传输入图）。
 */
const handles = new Map<string, CanvasTaskSpec>()

export function registerCanvasTask(taskId: string, spec: CanvasTaskSpec): void {
  handles.set(taskId, spec)
}

export function getCanvasTask(taskId: string): CanvasTaskSpec | undefined {
  return handles.get(taskId)
}

export function removeCanvasTask(taskId: string): void {
  handles.delete(taskId)
}

import type { PlacementTarget } from './placement'

/**
 * 一次画布生成任务的完整描述：提示词 + 输入图 + 放置目标。
 * 既是发起入口的参数，也是内存运行态里存的东西（两者本就同形）。
 */
export interface CanvasTaskSpec {
  prompt: string
  inputImageDataUrls: string[]
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

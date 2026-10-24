import type { TaskErrorType } from '@image-playground/shared'

/**
 * 失败分类在抛出的 Error 上捎带一程。
 *
 * 生成这条链路上失败一律以 `throw` 收场（BFF 轮询与浏览器侧请求共用同一个
 * catch），而 `Error` 只有一句 message。界面要按分类出文案与出路（ADR 0006），就得让分类
 * 跟着错误走到 `generationJob.superviseGeneration` 的 catch 里；`rawResponsePayload` 早就是这么带的，
 * 这里沿用同一种挂法，只是把读取收进一个带收窄的函数，省得每处再写一遍 `in` 判断。
 */
export function taskFailure(message: string, errorType?: TaskErrorType): Error {
  const error = new Error(message)
  if (errorType) Object.assign(error, { taskErrorType: errorType })
  return error
}

/** 任务在平台上被取消（排队中被撤回等）：不是失败，卡片要显示「已取消」。 */
export function taskCancelled(message: string): Error {
  return Object.assign(new Error(message), { taskCancelled: true })
}

export function isTaskCancelled(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'taskCancelled' in err && err.taskCancelled === true
}

/** 取回分类；没带分类（旧 BFF、认不出的失败、非 Error）时返回 undefined。 */
export function taskErrorTypeOf(err: unknown): TaskErrorType | undefined {
  if (!err || typeof err !== 'object' || !('taskErrorType' in err)) return undefined
  const carried = err.taskErrorType
  return typeof carried === 'string' ? (carried as TaskErrorType) : undefined
}

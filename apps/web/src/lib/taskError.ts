import {
  type AgentToolErrorCode,
  type TaskErrorType,
  taskFailureCode,
} from '@image-playground/shared'
import { i18next, UserFacingError } from '../i18n'

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
  return Object.assign(new UserFacingError(message), { taskCancelled: true })
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

/** 失败原因的一句话，按错误码取译文。没有码（旧记录）时返回 null，调用方照旧处理。 */
export function agentToolFailureText(code: AgentToolErrorCode | undefined): string | null {
  const t = i18next.getFixedT(null, 'errors')
  switch (code) {
    case undefined:
      return null
    case 'upstream_error':
      return t('agentTool.upstream_error')
    case 'timeout':
      return t('agentTool.timeout')
    case 'no_output':
      return t('agentTool.no_output')
    case 'result_unknown':
      return t('agentTool.result_unknown')
    case 'insufficient_credits':
      return t('agentTool.insufficient_credits')
    case 'quota_exceeded':
      return t('agentTool.quota_exceeded')
    case 'authentication_required':
      return t('agentTool.authentication_required')
    case 'invalid_params':
      return t('agentTool.invalid_params')
    case 'source_unavailable':
      return t('agentTool.source_unavailable')
    case 'content_policy':
      return t('agentTool.content_policy')
    case 'model_unavailable':
      return t('agentTool.model_unavailable')
    case 'service_unavailable':
      return t('agentTool.service_unavailable')
    case 'cancelled':
      return t('agentTool.cancelled')
    default:
      return t('agentTool.fallback')
  }
}

/** 任务失败分类 → 给用户看的一句话。上游原文只留在「复制完整报错」里（ADR 0006）。 */
export function taskErrorText(code: TaskErrorType): string {
  // 内容审核拒绝只有改提示词一条出路，用带出路的那句长话。
  if (code === 'content_policy') return i18next.t('detail.contentPolicy', { ns: 'task' })
  return (
    agentToolFailureText(taskFailureCode(code)) ?? i18next.t('agentTool.fallback', { ns: 'errors' })
  )
}

/** 任务记录上的失败文字。有分类按分类出：旧记录里存的可能是上游原文。 */
export function taskRecordErrorText(task: {
  readonly error?: string | null
  readonly errorCode?: TaskErrorType
}): string | null {
  return task.errorCode ? taskErrorText(task.errorCode) : task.error?.trim() || null
}

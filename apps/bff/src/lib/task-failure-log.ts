import type { TaskErrorType } from '@image-playground/shared'

/**
 * 失败原因出在用户这次请求本身、不是系统出了故障的任务：
 * - `content_policy`：提示词被上游的安全审核拒绝；
 * - `plan_required`：请求要的参数（如 4K）当前方案满足不了。
 * 其余原因（上游超时、模型不可用、存储出错……）都是运维要看的信号。
 */
const USER_SIDE_FAILURES: ReadonlySet<TaskErrorType> = new Set(['content_policy', 'plan_required'])

/**
 * 任务进入失败终态时 `task.failed` 日志记成什么级别。
 *
 * 管理后台的「后端错误日志」与 server-logs 告警都按 error 级别计数。用户内容被拒绝是预期内的结果，
 * 记成 error 会把它和真正的故障混在一起，让错误列表失去信号。降成 warn 之后日志与事件名不变，
 * 仍能在日志页按任务查到，只是不再算作错误。
 */
export function taskFailureLogLevel(errorType: TaskErrorType): 'warn' | 'error' {
  return USER_SIDE_FAILURES.has(errorType) ? 'warn' : 'error'
}

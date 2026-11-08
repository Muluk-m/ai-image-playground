import type { TaskErrorType } from '@image-playground/shared'

/**
 * 失败原因出在用户这次请求本身、不是系统出了故障的任务。
 *
 * 目前只有 `content_policy`：提示词被上游的安全审核拒绝。
 *
 * `plan_required` 不在其中：用户没有会员就要 4K 这类请求，提交时就被 403 挡住、不会建任务；
 * 任务走到 worker 再以 `plan_required` 结束，一定是直连没配置、直连密钥耗尽、严格模式下直连
 * 路由失败或超时、调度名额抢不到——都是我们这一侧的问题，运维要看。
 *
 * 与告警里的两处 SQL 口径一致（它们都只把 `content_policy` 排除在「系统失败」之外）：
 * `apps/bff/src/ops/app-alerts.ts` 的 generation 规则、`apps/admin/server/lib/ops.ts` 的 `recent_system_failed`。
 * 新增一类用户侧原因时，三处一起改。
 */
const USER_SIDE_FAILURES: ReadonlySet<TaskErrorType> = new Set(['content_policy'])

/**
 * 任务进入失败终态时 `task.failed` 日志记成什么级别。
 *
 * 管理后台的「后端错误日志」与今日错误、以及日志页的错误计数（`apps/admin/server/lib/today.ts`、
 * `server-logs.ts`）都按 error 级别算。用户内容被拒绝是预期内的结果，记成 error 会把它和真正的故障
 * 混在一起。降成 warn 之后日志与事件名不变，仍能在日志页按任务查到，只是不再算作错误。
 * （`server-logs` 告警判的是日志采集是否断了，不数 error 行，不受影响。）
 */
export function taskFailureLogLevel(errorType: TaskErrorType): 'warn' | 'error' {
  return USER_SIDE_FAILURES.has(errorType) ? 'warn' : 'error'
}

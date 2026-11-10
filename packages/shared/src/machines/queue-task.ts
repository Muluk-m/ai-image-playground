import { TASK_STATUSES, type TaskProgressPhase, type TaskStatus } from '../queue-protocol'
import { defineMachine } from '../state-machine'

/**
 * 队列任务 `tasks.status`。
 * 对话轮占用行可以直接以 `in_progress` 插入，不经过 `claim`。
 * `finish` / `cancel` / `requeue` 的写入在 `task-transitions.ts`，与积分结算同一函数，这里只定义转移，不改那份结算。
 */
export const queueTask = defineMachine({
  id: 'queue-task',
  states: TASK_STATUSES,
  events: [
    'claim',
    'retry',
    'resume_poll',
    'retry_archive',
    'reconcile',
    'succeed',
    'fail',
    'cancel',
  ] as const,
  transitions: {
    queued: { claim: 'in_progress', cancel: 'cancelled' },
    in_progress: {
      retry: 'queued',
      resume_poll: 'queued',
      retry_archive: 'queued',
      reconcile: 'reconciling',
      succeed: 'completed',
      fail: 'failed',
      cancel: 'cancelled',
    },
    reconciling: { succeed: 'completed', fail: 'failed' },
    completed: {},
    failed: {},
    cancelled: {},
  },
})

export type QueueTaskEvent = (typeof queueTask.events)[number]

/** CLI `/v1/jobs` 的六态投影。`reconciling` 对外仍是 running。 */
export const CLI_JOB_STATUSES = [
  'queued',
  'running',
  'persisting',
  'succeeded',
  'failed',
  'canceled',
] as const
export type CliJobStatus = (typeof CLI_JOB_STATUSES)[number]

export function projectCliJobStatus(status: TaskStatus, phase: TaskProgressPhase): CliJobStatus {
  switch (status) {
    case 'completed':
      return 'succeeded'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'canceled'
    case 'queued':
    case 'in_progress':
    case 'reconciling':
      return phase === 'confirming' ? 'persisting' : phase === 'queued' ? 'queued' : 'running'
    default: {
      const neverStatus: never = status
      return neverStatus
    }
  }
}

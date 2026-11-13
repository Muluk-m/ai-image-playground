import { defineMachine, type TaskProgressPhase } from '@image-playground/shared'
import type { TaskRecord, TaskStatus } from '../types'

/**
 * 工作台任务行和画布占位框共用的生成阶段。
 * 一次只有一个阶段，排队、出图、取消、完成不能再叠在一起。
 */
export const GENERATION_PHASES = [
  'batch-queued',
  'submitting',
  'queued',
  'generating',
  'reconnecting',
  'confirming',
  'reconciling',
  'done',
  'failed',
  'cancelled',
  'stale',
] as const

export type GenerationPhase = (typeof GENERATION_PHASES)[number]

export type GenerationActivity = {
  [Phase in GenerationPhase]: { readonly phase: Phase }
}[GenerationPhase]

export const GENERATION_EVENTS = [
  'release',
  'report-queued',
  'report-generating',
  'report-reconnecting',
  'report-confirming',
  'report-reconciling',
  'succeed',
  'fail',
  'cancel',
  'interrupt',
  'expire',
  'retry',
] as const

export type GenerationEvent = (typeof GENERATION_EVENTS)[number]

const live = {
  'report-queued': 'queued',
  'report-generating': 'generating',
  'report-reconnecting': 'reconnecting',
  'report-confirming': 'confirming',
  'report-reconciling': 'reconciling',
  succeed: 'done',
  fail: 'failed',
  cancel: 'cancelled',
  interrupt: 'failed',
  expire: 'stale',
} as const satisfies Record<string, GenerationPhase>

/** 阶段图。下一阶段只由当前阶段和事件决定。 */
export const generationActivityMachine = defineMachine({
  id: 'generation-activity',
  states: GENERATION_PHASES,
  events: GENERATION_EVENTS,
  transitions: {
    'batch-queued': {
      release: 'submitting',
      succeed: 'done',
      fail: 'failed',
      cancel: 'cancelled',
      interrupt: 'failed',
      expire: 'stale',
    },
    submitting: live,
    queued: live,
    generating: live,
    reconnecting: live,
    confirming: live,
    reconciling: live,
    done: {},
    failed: { fail: 'failed', cancel: 'cancelled', retry: 'submitting' },
    cancelled: { cancel: 'cancelled', retry: 'submitting' },
    stale: { expire: 'stale', fail: 'failed', retry: 'submitting' },
  },
})

const SERVER_PHASES = new Set<GenerationPhase>([
  'queued',
  'generating',
  'reconnecting',
  'confirming',
  'reconciling',
])

export function reportEvent(phase: TaskProgressPhase): GenerationEvent {
  switch (phase) {
    case 'queued':
      return 'report-queued'
    case 'generating':
      return 'report-generating'
    case 'reconnecting':
      return 'report-reconnecting'
    case 'confirming':
      return 'report-confirming'
    case 'reconciling':
      return 'report-reconciling'
    default: {
      const neverPhase: never = phase
      return neverPhase
    }
  }
}

type SentryBreadcrumb = {
  addBreadcrumb?: (crumb: { category: string; message: string; level: string }) => void
}

/** 非法转移不抛错：开发环境打警告，有 Sentry 时留一条 breadcrumb，界面保持原阶段。 */
export function applyGenerationActivity(
  current: GenerationActivity,
  event: GenerationEvent,
): GenerationActivity {
  const next = generationActivityMachine.tryStep(current.phase, event)
  if (!next) {
    noteIllegalGeneration(current.phase, event)
    return current
  }
  return { phase: next }
}

export function noteIllegalGeneration(phase: GenerationPhase, event: GenerationEvent): void {
  const message = `generation-activity: ${phase} + ${event} is illegal`
  try {
    if (import.meta.env.DEV) console.warn(message)
    ;(globalThis as { Sentry?: SentryBreadcrumb }).Sentry?.addBreadcrumb?.({
      category: 'generation-activity',
      message,
      level: 'warning',
    })
  } catch {
    // 记录失败也不能影响界面。
  }
}

export function isGenerationOpen(activity: GenerationActivity): boolean {
  return (
    activity.phase !== 'done' &&
    activity.phase !== 'failed' &&
    activity.phase !== 'cancelled' &&
    activity.phase !== 'stale'
  )
}

/** 工作台卡片还在转、要显示计时的阶段。本机排队还没发出去，不算。 */
export function showsGenerationTimer(activity: GenerationActivity): boolean {
  return isGenerationOpen(activity) && activity.phase !== 'batch-queued'
}

/**
 * 终态 status 盖过仍写着进行中的 activity。
 * 旧记录只改了 status、没改 activity 时，不能再被读成还在提交。
 * activity 自己已经是终态时保留它：取消和过期都落在 error 上，不能被收成普通失败。
 */
function activityUnlessTerminalStatus(
  stored: GenerationActivity | undefined,
  terminal: GenerationActivity | undefined,
  fallback: () => GenerationActivity,
): GenerationActivity {
  if (stored && !isGenerationOpen(stored)) return stored
  if (terminal) return terminal
  if (stored) return stored
  return fallback()
}

/**
 * 旧记录没有 activity。读的时候把叠在一起的标志折成一个阶段，
 * 终态上残留的排队阶段、已取消却仍标着进行中、完成后还挂着本机排队，都收掉。
 */
export function activityFromRecord(
  task: Pick<TaskRecord, 'status' | 'queuePhase' | 'cancelled' | 'batchQueued' | 'activity'>,
): GenerationActivity {
  const terminal: GenerationActivity | undefined =
    task.status === 'done'
      ? { phase: 'done' }
      : task.cancelled
        ? { phase: 'cancelled' }
        : task.status === 'error'
          ? { phase: 'failed' }
          : undefined
  return activityUnlessTerminalStatus(task.activity, terminal, () => {
    if (task.batchQueued) return { phase: 'batch-queued' }
    if (task.queuePhase && SERVER_PHASES.has(task.queuePhase)) return { phase: task.queuePhase }
    return { phase: 'submitting' }
  })
}

export function activityFromCanvas(placeholder: {
  status: 'loading' | 'error' | 'stale'
  meta: { queuePhase?: TaskProgressPhase; activity?: GenerationActivity }
}): GenerationActivity {
  const terminal: GenerationActivity | undefined =
    placeholder.status === 'stale'
      ? { phase: 'stale' }
      : placeholder.status === 'error'
        ? { phase: 'failed' }
        : undefined
  return activityUnlessTerminalStatus(placeholder.meta.activity, terminal, () => {
    if (placeholder.meta.queuePhase && SERVER_PHASES.has(placeholder.meta.queuePhase)) {
      return { phase: placeholder.meta.queuePhase }
    }
    return { phase: 'submitting' }
  })
}

/** 服务端任务状态第一次投影到客户端。不是从某个旧阶段转过来的。 */
export function activityFromServerStatus(
  status: 'queued' | 'in_progress' | 'reconciling' | 'completed' | 'failed' | 'cancelled',
): GenerationActivity {
  switch (status) {
    case 'completed':
      return { phase: 'done' }
    case 'failed':
      return { phase: 'failed' }
    case 'cancelled':
      return { phase: 'cancelled' }
    case 'queued':
      return { phase: 'queued' }
    case 'in_progress':
      return { phase: 'generating' }
    case 'reconciling':
      return { phase: 'reconciling' }
    default: {
      const neverStatus: never = status
      return neverStatus
    }
  }
}

export function projectGenerationActivity(activity: GenerationActivity): {
  status: TaskStatus
  queuePhase: TaskProgressPhase | undefined
  cancelled: true | undefined
  batchQueued: true | undefined
} {
  switch (activity.phase) {
    case 'batch-queued':
      return {
        status: 'running',
        queuePhase: undefined,
        cancelled: undefined,
        batchQueued: true,
      }
    case 'submitting':
      return {
        status: 'running',
        queuePhase: undefined,
        cancelled: undefined,
        batchQueued: undefined,
      }
    case 'queued':
    case 'generating':
    case 'reconnecting':
    case 'confirming':
    case 'reconciling':
      return {
        status: 'running',
        queuePhase: activity.phase,
        cancelled: undefined,
        batchQueued: undefined,
      }
    case 'done':
      return { status: 'done', queuePhase: undefined, cancelled: undefined, batchQueued: undefined }
    case 'failed':
    case 'stale':
      return {
        status: 'error',
        queuePhase: undefined,
        cancelled: undefined,
        batchQueued: undefined,
      }
    case 'cancelled':
      return {
        status: 'error',
        queuePhase: undefined,
        cancelled: true,
        batchQueued: undefined,
      }
    default: {
      const neverActivity: never = activity
      return neverActivity
    }
  }
}

export function canvasProjection(activity: GenerationActivity): {
  status: 'loading' | 'error' | 'stale'
  queuePhase: TaskProgressPhase | undefined
} {
  if (!isGenerationOpen(activity)) {
    return {
      status: activity.phase === 'stale' ? 'stale' : 'error',
      queuePhase: undefined,
    }
  }
  if (activity.phase === 'batch-queued' || activity.phase === 'submitting') {
    return { status: 'loading', queuePhase: undefined }
  }
  if (
    activity.phase === 'queued' ||
    activity.phase === 'generating' ||
    activity.phase === 'reconnecting' ||
    activity.phase === 'confirming' ||
    activity.phase === 'reconciling'
  ) {
    return { status: 'loading', queuePhase: activity.phase }
  }
  return { status: 'loading', queuePhase: undefined }
}

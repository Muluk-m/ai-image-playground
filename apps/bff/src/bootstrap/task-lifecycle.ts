import { taskFailureCode } from '@image-playground/shared'
import {
  registerTaskLifecycleListener,
  type TaskLifecycleListener,
} from '../modules/execution/task-lifecycle-bus'

const generationMediaListener: TaskLifecycleListener = {
  id: 'generation-media',
  stage: 'before-settlement',
  async onTaskFinished(tx, event) {
    if (!event.userId || !event.media) return
    const { publishGenerationImages } = await import('../lib/generationMedia')
    await publishGenerationImages(tx, event.userId, event.taskId, event.media)
  },
}

const projectArchiveListener: TaskLifecycleListener = {
  id: 'project-archive',
  stage: 'before-settlement',
  async onTaskFinished(tx, event) {
    if (!event.userId) return
    const [{ publishProjectOutputs }, { partialFailureOf }] = await Promise.all([
      import('../lib/projectArchive'),
      import('../lib/upstream/partial'),
    ])
    const partial = partialFailureOf(event.resultPayload)
    const failure =
      event.status === 'failed'
        ? taskFailureCode(event.errorType)
        : // 部分出图：没出的那几个预留位置留成失败占位，不悄悄收掉。
          partial
          ? taskFailureCode(partial.type)
          : undefined
    await publishProjectOutputs(tx, event.userId, event.taskId, event.media ?? [], failure)
  },
  async onTasksCancelled(tx, event) {
    const { publishProjectOutputs } = await import('../lib/projectArchive')
    for (const task of event.tasks) {
      if (task.userId) {
        await publishProjectOutputs(tx, task.userId, task.taskId, [], event.failedAs)
      }
    }
  },
}

const modelAvailabilityListener: TaskLifecycleListener = {
  id: 'model-availability',
  stage: 'after-settlement',
  async onTaskFinished(tx, event) {
    if (event.status !== 'failed' || event.errorType !== 'model_unavailable') return
    const { pauseUnavailableModel } = await import('../lib/model-availability')
    await pauseUnavailableModel(tx, event.model, event.completedAt)
  },
}

const agentWakeListener: TaskLifecycleListener = {
  id: 'agent-wake',
  stage: 'after-settlement',
  async onTaskFinished(tx, event) {
    const { agentJobsEnded } = await import('../lib/agent/wake')
    await agentJobsEnded(tx, [event.taskId], event.completedAt)
  },
  async onTasksCancelled(tx, event) {
    const { agentJobsEnded } = await import('../lib/agent/wake')
    await agentJobsEnded(
      tx,
      event.tasks.map((task) => task.taskId),
      event.completedAt,
    )
  },
}

const DEFAULT_TASK_LIFECYCLE_LISTENERS: readonly TaskLifecycleListener[] = [
  generationMediaListener,
  projectArchiveListener,
  modelAvailabilityListener,
  agentWakeListener,
]

/**
 * 组合根注册内置的任务终态事务内监听器（幂等）：
 * 保持 `modules/execution` 与上层模块（media / projectArchive / model-availability / agent）单向解耦。
 * 监听器内部采用惰性 import，避免在配置未初始化或单测部分 mock 阶段提前求值业务模块。
 */
export function registerDefaultTaskLifecycleListeners(): void {
  for (const listener of DEFAULT_TASK_LIFECYCLE_LISTENERS) {
    registerTaskLifecycleListener(listener)
  }
}

registerDefaultTaskLifecycleListeners()

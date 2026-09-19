import type { GenerationSummary, TaskStatus as QueueStatus } from '@image-playground/shared'
import { useStore } from '../store'
import { DEFAULT_PARAMS, type TaskParams, type TaskRecord, type TaskStatus } from '../types'
import { getAllTasks, putTask } from './db'
import { mediaRef } from './remoteGenerations'

/**
 * 平台记录的本机镜像。
 *
 * 作品页只认一种卡，所以只存在平台上的生成也要变成一条普通任务记录：像素留在平台，用
 * `aip-media:<id>` 引用（和云端画布用的是同一个原语），其余字段按接口给的照抄。用户不该
 * 从卡片形态上看出一件作品的像素存在哪儿。
 */
export function taskFromGeneration(item: GenerationSummary): TaskRecord {
  const cover = item.cover ? [mediaRef(item.cover.mediaId)] : []
  return {
    id: item.id,
    bffRequestId: item.id,
    prompt: item.prompt,
    params: paramsFromGeneration(item),
    actualParams: pickActual(item),
    apiModel: item.model,
    inputImageIds: [],
    outputImages: cover,
    status: statusFromGeneration(item.status),
    error: item.errorType,
    createdAt: item.createdAt,
    finishedAt: item.completedAt,
    elapsed: item.completedAt && item.startedAt ? item.completedAt - item.startedAt : null,
    remoteOnly: true,
  }
}

/**
 * 把这一页平台记录并进本机历史。本机已有同一条生成（id 相同，或本机任务记的
 * `bffRequestId` 指向它）时保持原样：本机那条带着真实像素、收藏与参考图，比镜像完整。
 */
export async function mirrorGenerations(items: readonly GenerationSummary[]): Promise<void> {
  if (items.length === 0) return
  // 落盘的和内存里的都算「已经有了」：刚提交还没写完的任务也不该被镜像成第二张卡。
  const stored = [...(await getAllTasks()), ...useStore.getState().tasks]
  const known = new Set<string>()
  for (const task of stored) {
    known.add(task.id)
    if (task.bffRequestId) known.add(task.bffRequestId)
  }
  const mirrored = items.filter((item) => !known.has(item.id)).map(taskFromGeneration)
  if (mirrored.length === 0) return
  await Promise.all(mirrored.map((task) => putTask(task)))
  useStore.setState((state) => {
    const present = new Set(state.tasks.map((task) => task.id))
    const added = mirrored.filter((task) => !present.has(task.id))
    if (added.length === 0) return state
    return { tasks: [...state.tasks, ...added] }
  })
}

function statusFromGeneration(status: QueueStatus): TaskStatus {
  if (status === 'completed') return 'done'
  if (status === 'queued' || status === 'in_progress') return 'running'
  return 'error'
}

function paramsFromGeneration(item: GenerationSummary): TaskParams {
  const { size, quality, output_format, output_compression, n } = item.parameters
  return {
    ...DEFAULT_PARAMS,
    ...(size ? { size } : {}),
    ...(quality ? { quality: quality as TaskParams['quality'] } : {}),
    ...(output_format ? { output_format: output_format as TaskParams['output_format'] } : {}),
    ...(output_compression == null ? {} : { output_compression }),
    ...(typeof n === 'number' ? { n } : {}),
  }
}

function pickActual(item: GenerationSummary): Partial<TaskParams> | undefined {
  const { size, quality, output_format } = item.actualParameters
  const actual = {
    ...(size ? { size } : {}),
    ...(quality ? { quality: quality as TaskParams['quality'] } : {}),
    ...(output_format ? { output_format: output_format as TaskParams['output_format'] } : {}),
  }
  return Object.keys(actual).length > 0 ? actual : undefined
}

import { VIDEO_MODEL_SUPPORT } from '@image-playground/shared'
import { VIDEO_SOURCES, type VideoSource, type VideoTask } from '../types'

export const ALL_FILTER = 'all'
export const RUNNING_FILTER = 'running'

const SOURCE_PREFIX = 'source:'
const MODEL_PREFIX = 'model:'

/** 工具条上的短标签，区别于左栏的「文生视频 / 图生视频」。 */
const FEED_SOURCE_LABELS: Record<VideoSource, string> = { text: '文生', image: '图生' }

export interface VideoFeedFilter {
  id: string
  label: string
  count: number
}

export function isVideoTaskActive(task: VideoTask): boolean {
  return task.status === 'queued' || task.status === 'running'
}

/** 只列出结果流里真有的来源与模型，避免出现点了必然空的筛选。 */
export function videoFeedFilters(tasks: readonly VideoTask[]): VideoFeedFilter[] {
  const filters: VideoFeedFilter[] = [{ id: ALL_FILTER, label: '全部', count: tasks.length }]
  const count = (match: (task: VideoTask) => boolean) => tasks.filter(match).length

  const running = count(isVideoTaskActive)
  if (running > 0) filters.push({ id: RUNNING_FILTER, label: '生成中', count: running })

  for (const source of VIDEO_SOURCES) {
    const total = count((task) => task.source === source)
    if (total > 0) {
      filters.push({
        id: `${SOURCE_PREFIX}${source}`,
        label: FEED_SOURCE_LABELS[source],
        count: total,
      })
    }
  }

  for (const model of [...new Set(tasks.map((task) => task.model))]) {
    filters.push({
      id: `${MODEL_PREFIX}${model}`,
      label: VIDEO_MODEL_SUPPORT[model]?.label ?? model,
      count: count((task) => task.model === model),
    })
  }

  return filters
}

function matchesFilter(task: VideoTask, filterId: string): boolean {
  if (filterId === RUNNING_FILTER) return isVideoTaskActive(task)
  if (filterId.startsWith(SOURCE_PREFIX))
    return task.source === filterId.slice(SOURCE_PREFIX.length)
  if (filterId.startsWith(MODEL_PREFIX)) return task.model === filterId.slice(MODEL_PREFIX.length)
  return true
}

/** 生成中的排在最前，其余按新到旧。 */
export function filterVideoTasks(
  tasks: readonly VideoTask[],
  filterId: string,
  query: string,
): VideoTask[] {
  const needle = query.trim().toLowerCase()
  return tasks
    .filter(
      (task) =>
        matchesFilter(task, filterId) && (!needle || task.prompt.toLowerCase().includes(needle)),
    )
    .sort(
      (a, b) =>
        Number(isVideoTaskActive(b)) - Number(isVideoTaskActive(a)) || b.createdAt - a.createdAt,
    )
}

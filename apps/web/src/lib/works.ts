import type { GenerationSummary, GenerationTotals } from '@image-playground/shared'
import { parseImageSize } from '@image-playground/shared'
import { clampRatio } from '../features/inspiration/lib/masonry'
import type { TaskRecord } from '../types'
import { parseRatio } from './size'

/** 作品页签的来源筛选。历史上没记来源的平台记录只出现在「全部」里。 */
export type WorksFilter = 'all' | 'studio' | 'agent'
export type WorkSource = 'studio' | 'agent' | 'unknown'

export type WorksCounts = Record<WorksFilter, number>

interface SourceRecord {
  readonly record: Pick<GenerationSummary, 'source'>
}

/** 平台记录的来源；本机跑的任务都是快速生成。 */
export function sourceOfRecord(record: Pick<GenerationSummary, 'source'>): WorkSource {
  const kind = record.source?.kind
  return kind === 'studio' || kind === 'agent' ? kind : 'unknown'
}

export function workSource(
  task: TaskRecord,
  rowsById: ReadonlyMap<string, SourceRecord>,
): WorkSource {
  const row = rowsById.get(task.bffRequestId ?? task.id)
  if (row) return sourceOfRecord(row.record)
  return task.remoteOnly ? 'unknown' : 'studio'
}

/** 对话产出回到它的项目；没有项目（或不是对话产出）就是 null。 */
export function workProjectId(
  task: TaskRecord,
  rowsById: ReadonlyMap<string, SourceRecord>,
): string | null {
  const source = rowsById.get(task.bffRequestId ?? task.id)?.record.source
  return source?.kind === 'agent' ? source.projectId : null
}

export function matchesWorksFilter(source: WorkSource, filter: WorksFilter): boolean {
  return filter === 'all' || source === filter
}

/**
 * 瀑布流里这张卡的高/宽。实测像素优先，其次请求的尺寸或 Gemini 比例；都没有就用默认比例。
 * 布局只认已知比例、不等图片加载：卡片不会在图片到达后跳位。
 */
export function workRatio(task: TaskRecord): number {
  const measured = task.measuredSize ? parseImageSize(task.measuredSize) : null
  if (measured) return clampRatio(measured.height / measured.width)
  const actual = task.actualParams?.size ? parseImageSize(task.actualParams.size) : null
  if (actual) return clampRatio(actual.height / actual.width)
  const requested = task.params.size ? parseImageSize(task.params.size) : null
  if (requested) return clampRatio(requested.height / requested.width)
  const ratio = task.params.gemini_aspect_ratio ? parseRatio(task.params.gemini_aspect_ratio) : null
  if (ratio) return clampRatio(ratio.height / ratio.width)
  return clampRatio(Number.NaN)
}

/**
 * 服务端总数的那一刻：`totals` 是第一页带回来的条数；`known` 是那以后服务端确认过存在的记录
 * （翻到的每一页加上当时已在缓存里的）；`at` 是发出第一页请求时的本机时间。
 */
export interface WorksSnapshot {
  readonly totals: GenerationTotals
  readonly known: ReadonlyMap<string, WorkSource>
  readonly at: number
}

/**
 * 作品页签上的数字。以服务端总数为准，不按已经翻到的条数数：
 * - 服务端确认过、现在已经不在时间线里的（刚删掉的）减掉；
 * - 本机的新任务（快照之后才发起，或者根本没上过平台）加上。
 * 没有快照（未登录、第一页还没回来）就按手上的时间线数。
 */
export function worksCounts(
  tasks: readonly TaskRecord[],
  rowsById: ReadonlyMap<string, SourceRecord>,
  snapshot: WorksSnapshot | null,
): WorksCounts {
  const counts: WorksCounts = { all: 0, studio: 0, agent: 0 }
  const add = (source: WorkSource, delta: number) => {
    counts.all += delta
    if (source !== 'unknown') counts[source] += delta
  }
  if (!snapshot) {
    for (const task of tasks) add(workSource(task, rowsById), 1)
    return counts
  }
  add('unknown', snapshot.totals.all)
  counts.studio = snapshot.totals.studio
  counts.agent = snapshot.totals.agent
  const present = new Set<string>()
  for (const task of tasks) {
    present.add(task.id)
    if (task.bffRequestId) present.add(task.bffRequestId)
  }
  for (const [id, source] of snapshot.known) if (!present.has(id)) add(source, -1)
  for (const task of tasks) {
    if (task.remoteOnly) continue
    const serverId = task.bffRequestId ?? task.id
    if (snapshot.known.has(serverId)) continue
    // 快照之前就提交到平台的本机任务已经在总数里。
    if (task.bffRequestId && task.createdAt <= snapshot.at) continue
    add('studio', 1)
  }
  return {
    all: Math.max(0, counts.all),
    studio: Math.max(0, counts.studio),
    agent: Math.max(0, counts.agent),
  }
}

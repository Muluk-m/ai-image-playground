import type { TaskRecord } from '../types'

/** 本机还没有同模型完成记录时按这个时长估算（QA R1 实测首图 32–51 秒）。 */
export const DEFAULT_TYPICAL_MS = 40_000
/** 取最近几次同模型完成任务的耗时中位数。 */
const SAMPLE_SIZE = 10
/** 到典型耗时时进度停在 85%，之后越来越慢，永远不到 100%。 */
const RATE = -Math.log(0.15)
const MAX_PERCENT = 99

/**
 * 估算进度百分比。上游不回报真实进度，这里只按已等时长和本机同模型的典型耗时推算，
 * 前快后慢、不会倒退，也不会在出图前显示 100%。
 */
export function estimatedProgressPercent(elapsedMs: number, typicalMs: number): number {
  if (!(elapsedMs > 0) || !(typicalMs > 0)) return 0
  const fraction = 1 - Math.exp((-RATE * elapsedMs) / typicalMs)
  return Math.min(MAX_PERCENT, Math.floor(fraction * 100))
}

/** 同模型最近完成任务的耗时中位数；没有样本时用默认值。`tasks` 按 store 的顺序新的在前。 */
export function typicalDurationMs(tasks: readonly TaskRecord[], model: string | undefined): number {
  const samples: number[] = []
  for (const task of tasks) {
    if (samples.length >= SAMPLE_SIZE) break
    if (task.status !== 'done' || task.elapsed == null || task.elapsed <= 0) continue
    if ((task.apiModel ?? '') !== (model ?? '')) continue
    samples.push(task.elapsed)
  }
  if (samples.length === 0) return DEFAULT_TYPICAL_MS
  samples.sort((a, b) => a - b)
  const mid = Math.floor(samples.length / 2)
  return samples.length % 2 ? samples[mid]! : (samples[mid - 1]! + samples[mid]!) / 2
}

type ProgressTask = Pick<
  TaskRecord,
  'id' | 'queuePhase' | 'batchStartedAt' | 'createdAt' | 'platformTask' | 'bffRequestId'
>

const generatingSince = new Map<string, number>()

/** 走平台队列的任务（含旧版没有 queuePhase 的平台任务）：排队时间不能算进进度。 */
function isQueued(task: ProgressTask): boolean {
  return task.queuePhase != null || Boolean(task.platformTask || task.bffRequestId)
}

/**
 * 估算的起点。本机直接出图的任务从开始算；平台队列任务从第一次看到「生成中」算，
 * 还没记下时返回 null（不显示百分比）。记在模块里，卡片重新挂载也不会让进度倒退。
 */
export function progressStartedAt(task: ProgressTask): number | null {
  if (!isQueued(task)) return task.batchStartedAt ?? task.createdAt
  return generatingSince.get(task.id) ?? null
}

/** 卡片提交后看到任务进入生成中时记下起点；只记第一次。 */
export function markGenerating(task: ProgressTask, at: number): void {
  if (isQueued(task) && !generatingSince.has(task.id)) generatingSince.set(task.id, at)
}

/** 任务结束后丢掉起点。 */
export function forgetGenerating(id: string): void {
  generatingSince.delete(id)
}

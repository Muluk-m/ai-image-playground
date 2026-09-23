import type {
  GenerationDetail,
  GenerationSummary,
  TaskStatus as QueueStatus,
} from '@image-playground/shared'
import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { useStore } from '../store'
import {
  DEFAULT_PARAMS,
  GEMINI_ASPECT_RATIOS,
  GEMINI_IMAGE_SIZES,
  GEMINI_THINKING_LEVELS,
  type TaskParams,
  type TaskRecord,
  type TaskStatus,
} from '../types'
import { deleteCachedGeneration, getCachedGenerations, putCachedGeneration } from './db'
import { mediaRef, readRemoteGeneration } from './remoteGenerations'
import type { CloudReuseSource } from './reuseCloudGeneration'

/**
 * 平台记录的本机缓存。
 *
 * 作品页只认一种卡，所以平台上的生成也要能当成一条普通任务记录来渲染——但它**不是**本机数据：
 * 权威只在平台，这里存的是一份可整体替换的读缓存，卡片由 `taskFromGeneration` 在读的时候投影出来。
 * 早先的实现把它当本机记录写进 `tasks` 表，于是平台删掉的记录在本机变成永远删不掉的幽灵卡，
 * 状态、参考图、产出各要一条回头路去对账。
 *
 * 收藏是本机对这条平台记录的标注，不随缓存刷新丢失。
 */
export interface PlatformGenerationRow {
  id: string
  record: GenerationSummary | GenerationDetail
  favorite?: true
  fetchedAt: number
}

/** 缓存只为渲染最近这一段时间线，不做无限增长的本机副本。 */
const MAX_CACHED = 500

/** 平台记录 → 作品卡。像素留在平台，用 `aip-media:<id>` 引用（和云端画布同一个原语）。 */
export function taskFromGeneration(
  item: GenerationSummary | GenerationDetail,
  favorite?: true,
): TaskRecord {
  const cover = item.cover ? [mediaRef(item.cover.mediaId)] : []
  // 列表只给封面，详情给整组产出；读到哪一份就用哪一份。
  const outputs = 'outputs' in item ? item.outputs.map((image) => mediaRef(image.mediaId)) : []
  const inputs = item.inputs.map((image) => mediaRef(image.mediaId))
  const mask = item.mask ? mediaRef(item.mask.mediaId) : null
  return {
    id: item.id,
    bffRequestId: item.id,
    prompt: item.prompt,
    params: paramsFromGeneration(item),
    actualParams: pickActual(item),
    apiModel: item.model,
    // 复用要认回内置 channel，认的是 provider + model 这一对，所以 provider 也得留在卡上。
    cloudProvider: item.provider,
    inputImageIds: inputs,
    maskImageId: mask,
    maskTargetImageId: mask ? (inputs[0] ?? null) : null,
    outputImages: outputs.length > 0 ? outputs : cover,
    ...statusPatch(item),
    createdAt: item.createdAt,
    remoteOnly: true,
    ...(favorite ? { isFavorite: true } : {}),
  }
}

/** 平台记录 → 复用所需材料。列表条目和详情是同一种投影，两条路不会各算一套参数。 */
export function cloudReuseSourceFromGeneration(item: GenerationSummary): CloudReuseSource {
  return {
    provider: item.provider,
    model: item.model,
    prompt: item.prompt,
    params: paramsFromGeneration(item),
    inputs: item.inputs.map((image) => mediaRef(image.mediaId)),
    mask: item.mask ? mediaRef(item.mask.mediaId) : null,
  }
}

/** 作品页第一帧要有东西可看，所以缓存落盘；启动时读回来。 */
export async function loadPlatformGenerations(): Promise<void> {
  const rows = await getCachedGenerations().catch(() => [])
  useStore.getState().setPlatformGenerations(sortRows(rows))
  for (const row of rows) {
    if (statusFromGeneration(row.record.status) === 'running') watchPlatformGeneration(row.id)
  }
}

/**
 * 收下一页平台记录。
 *
 * `until` 是这一页覆盖的时间上界（第一页没有上界）；`hasMore` 说明这一页下面还有没有更早的记录。
 * 平台在这一页真正覆盖的窗口里是权威：窗口内缓存有、这一页没有的记录就是**平台上已经没有了**，
 * 直接丢掉。删除因此不需要墓碑，也不需要拿 404 去试探。窗口之外一律不动——翻页不等于「没有了」。
 */
export async function receivePlatformPage(
  items: readonly GenerationSummary[],
  { until = Number.POSITIVE_INFINITY, hasMore = false } = {},
): Promise<void> {
  const returned = new Map(items.map((item) => [item.id, item]))
  // 这一页读满了、后面还有，就只能替换到最后一条为止；读到底了，下界就是时间线的开头。
  const since = hasMore
    ? items.reduce((lowest, item) => Math.min(lowest, item.createdAt), Number.POSITIVE_INFINITY)
    : Number.NEGATIVE_INFINITY
  const previous = useStore.getState().platformGenerations
  const kept: PlatformGenerationRow[] = []
  const dropped: string[] = []
  for (const row of previous) {
    if (returned.has(row.id)) continue
    const inWindow = row.record.createdAt >= since && row.record.createdAt <= until
    if (inWindow) dropped.push(row.id)
    else kept.push(row)
  }
  const favorites = new Map(previous.map((row) => [row.id, row.favorite]))
  const now = Date.now()
  const received = items.map((item): PlatformGenerationRow => {
    const favorite = favorites.get(item.id)
    return { id: item.id, record: item, fetchedAt: now, ...(favorite ? { favorite } : {}) }
  })
  const rows = sortRows([...kept, ...received])
  const pruned = rows.slice(MAX_CACHED)
  await commit(rows.slice(0, MAX_CACHED), received, [...dropped, ...pruned.map((row) => row.id)])
  for (const item of items) {
    if (statusFromGeneration(item.status) === 'running') watchPlatformGeneration(item.id)
  }
}

/** 详情读到的比列表全（产出是整组），照单更新这条缓存。 */
export async function refreshPlatformGeneration(record: GenerationDetail): Promise<void> {
  const rows = useStore.getState().platformGenerations
  const existing = rows.find((row) => row.id === record.id)
  const next: PlatformGenerationRow = {
    id: record.id,
    record,
    fetchedAt: Date.now(),
    ...(existing?.favorite ? { favorite: existing.favorite } : {}),
  }
  const merged = existing
    ? rows.map((row) => (row.id === record.id ? next : row))
    : sortRows([...rows, next])
  await commit(merged, [next], [])
}

/** 收藏是本机标注，写在缓存行上，刷新缓存时留着。 */
export async function setPlatformFavorite(id: string, favorite: boolean): Promise<void> {
  const rows = useStore.getState().platformGenerations
  const existing = rows.find((row) => row.id === id)
  if (!existing) return
  const { favorite: _previous, ...rest } = existing
  const next: PlatformGenerationRow = favorite ? { ...rest, favorite: true } : rest
  await commit(
    rows.map((row) => (row.id === id ? next : row)),
    [next],
    [],
  )
}

/** 平台删成功之后把这行也丢了；本机丢不算删，删除的权威在平台。 */
export async function dropPlatformGeneration(id: string): Promise<void> {
  const rows = useStore.getState().platformGenerations
  await commit(
    rows.filter((row) => row.id !== id),
    [],
    [id],
  )
}

export function isPlatformGeneration(id: string): boolean {
  return useStore.getState().platformGenerations.some((row) => row.id === id)
}

/**
 * 作品页那一条时间线：本机记录加平台记录缓存。本机自己跑的那条（id 相同，或 `bffRequestId`
 * 指向它）压住平台那条——它带着真实像素、收藏与参考图，比缓存完整。
 */
export function mergeHistory(
  tasks: readonly TaskRecord[],
  rows: readonly PlatformGenerationRow[],
): TaskRecord[] {
  const owned = new Set<string>()
  for (const task of tasks) {
    owned.add(task.id)
    if (task.bffRequestId) owned.add(task.bffRequestId)
  }
  const projected = rows
    .filter((row) => !owned.has(row.id))
    .map((row) => taskFromGeneration(row.record, row.favorite))
  return [...tasks, ...projected]
}

const watched = new Set<string>()

/**
 * 盯着平台上还在跑的那条生成，直到它落终态。它不是本机发起的，没有 `superviseGeneration` 那条连接可以等；
 * 不盯着它，卡片只能等下一次重读列表或展开详情才收尾。
 *
 * 轮询梯度与本机队列任务共用一份（最长 30 min）。超时仍未落终态就停手：平台侧的无主扫描会把它
 * 写成失败，下一次读列表或展开详情照样能收尾，这里不替平台判死。
 */
export function watchPlatformGeneration(id: string): void {
  if (watched.has(id)) return
  watched.add(id)
  void pollPlatformGeneration(id).finally(() => watched.delete(id))
}

async function pollPlatformGeneration(id: string): Promise<void> {
  const { POLL_BACKOFF_MS, POLL_MAX_MS } = QUEUE_TIMEOUTS
  const deadline = Date.now() + POLL_MAX_MS
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    // apps/web 的 lib target 还没到 es2024，这里用不了 Promise.withResolvers。
    await new Promise((resolve) =>
      setTimeout(resolve, POLL_BACKOFF_MS[Math.min(attempt, POLL_BACKOFF_MS.length - 1)]),
    )
    const row = useStore.getState().platformGenerations.find((item) => item.id === id)
    // 记录被删了，或者列表刷新 / 展开详情已经替它收过尾：这一轮就不用读了。
    if (!row || statusFromGeneration(row.record.status) !== 'running') return
    // 读不到（离线、5xx、临时 404）不算结论，下一轮再来。
    const detail = await readRemoteGeneration(id)
    if (!detail) continue
    await refreshPlatformGeneration(detail)
    if (statusFromGeneration(detail.status) !== 'running') return
  }
}

/** 内存与落盘一起改：缓存不落盘，作品页第一帧就只剩本机记录。 */
async function commit(
  rows: PlatformGenerationRow[],
  written: readonly PlatformGenerationRow[],
  removed: readonly string[],
): Promise<void> {
  useStore.getState().setPlatformGenerations(rows)
  await Promise.all([
    ...written.map((row) => putCachedGeneration(row).catch(() => undefined)),
    ...removed.map((id) => deleteCachedGeneration(id).catch(() => undefined)),
  ])
}

function sortRows(rows: readonly PlatformGenerationRow[]): PlatformGenerationRow[] {
  return [...rows].sort((a, b) => b.record.createdAt - a.record.createdAt)
}

/**
 * 平台记录里的状态与耗时。卡片的终态只有这一个来源，抄的时候必须连着抄：
 * 2026-09-21 详情已经读到 `completed`、只更新了产出与参考图，卡片就一直停在「生成中」。
 */
function statusPatch(
  item: GenerationSummary,
): Pick<TaskRecord, 'status' | 'error' | 'finishedAt' | 'elapsed'> {
  return {
    status: statusFromGeneration(item.status),
    error: item.errorType,
    finishedAt: item.completedAt,
    elapsed: item.completedAt && item.startedAt ? item.completedAt - item.startedAt : null,
  }
}

function statusFromGeneration(status: QueueStatus): TaskStatus {
  if (status === 'completed') return 'done'
  if (status === 'queued' || status === 'in_progress') return 'running'
  return 'error'
}

/**
 * 平台记录的参数投影。Gemini 那三项也照抄：这份参数同时是卡面显示和「复用配置」的来源，
 * 漏掉它们，复用一条 Gemini 生成就会悄悄换掉画面比例、分辨率档位和思考级别。
 */
function paramsFromGeneration(item: GenerationSummary): TaskParams {
  const { size, quality, output_format, output_compression, n } = item.parameters
  const { aspect_ratio, image_size, thinking_level } = item.parameters
  return {
    ...DEFAULT_PARAMS,
    ...(size ? { size } : {}),
    ...(quality ? { quality: quality as TaskParams['quality'] } : {}),
    ...(output_format ? { output_format: output_format as TaskParams['output_format'] } : {}),
    ...(output_compression == null ? {} : { output_compression }),
    ...(typeof n === 'number' ? { n } : {}),
    gemini_aspect_ratio: GEMINI_ASPECT_RATIOS.find((value) => value === aspect_ratio),
    gemini_image_size: GEMINI_IMAGE_SIZES.find((value) => value === image_size),
    gemini_thinking_level: GEMINI_THINKING_LEVELS.find((value) => value === thinking_level),
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

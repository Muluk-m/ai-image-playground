import type { GenerationSummary, TaskStatus as QueueStatus } from '@image-playground/shared'
import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { updateTaskInStore, useStore } from '../store'
import {
  DEFAULT_PARAMS,
  GEMINI_ASPECT_RATIOS,
  GEMINI_IMAGE_SIZES,
  GEMINI_THINKING_LEVELS,
  type TaskParams,
  type TaskRecord,
  type TaskStatus,
} from '../types'
import { getAllTasks, putTask } from './db'
import { mediaRef, readRemoteGeneration } from './remoteGenerations'
import type { CloudReuseSource } from './reuseCloudGeneration'

/**
 * 平台记录的本机镜像。
 *
 * 作品页只认一种卡，所以只存在平台上的生成也要变成一条普通任务记录：像素留在平台，用
 * `aip-media:<id>` 引用（和云端画布用的是同一个原语），其余字段按接口给的照抄。用户不该
 * 从卡片形态上看出一件作品的像素存在哪儿。
 */
export function taskFromGeneration(item: GenerationSummary): TaskRecord {
  const cover = item.cover ? [mediaRef(item.cover.mediaId)] : []
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
    outputImages: cover,
    ...mirrorStatusPatch(item),
    createdAt: item.createdAt,
    remoteOnly: true,
  }
}

/**
 * 平台记录 → 复用所需材料。列表条目和详情是同一种投影，所以老卡回退读详情时走的也是这里，
 * 两条路不会各算一套参数。
 */
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

/**
 * 把这一页平台记录并进本机历史。本机自己跑的那条（id 相同，或本机任务记的
 * `bffRequestId` 指向它）保持原样：它带着真实像素、收藏与参考图，比镜像完整。
 *
 * 镜像卡不一样：它没有本机连接在等结果，状态只能一次次从平台抄。读到它时还在跑、
 * 之后再读到已经跑完，就得就地收尾——否则那张卡会永远转下去。
 */
export async function mirrorGenerations(items: readonly GenerationSummary[]): Promise<void> {
  if (items.length === 0) return
  // 落盘的和内存里的都算「已经有了」：刚提交还没写完的任务也不该被镜像成第二张卡。
  const stored = [...(await getAllTasks()), ...useStore.getState().tasks]
  const known = new Map<string, TaskRecord>()
  for (const task of stored) {
    known.set(task.id, task)
    if (task.bffRequestId) known.set(task.bffRequestId, task)
  }
  const writes: TaskRecord[] = []
  for (const item of items) {
    const existing = known.get(item.id)
    if (!existing) {
      writes.push(taskFromGeneration(item))
      continue
    }
    const refreshed = refreshMirror(existing, item)
    if (refreshed) writes.push(refreshed)
  }
  if (writes.length > 0) {
    await Promise.all(writes.map((task) => putTask(task)))
    useStore.setState((state) => {
      const written = new Map(writes.map((task) => [task.id, task]))
      const present = new Set(state.tasks.map((task) => task.id))
      return {
        tasks: [
          ...state.tasks.map((task) => written.get(task.id) ?? task),
          ...writes.filter((task) => !present.has(task.id)),
        ],
      }
    })
  }
  const tasks = useStore.getState().tasks
  for (const item of items) {
    const task = tasks.find((candidate) => candidate.id === item.id)
    if (task?.remoteOnly && task.status === 'running') watchMirroredGeneration(item.id)
  }
}

/**
 * 用这一页的平台记录刷新本机那条镜像。本机自己跑的任务由 `executeTask` 写终态，这里一概不碰。
 *
 * 镜像是平台状态的投影，所以整条按列表重算，而不只是补状态：早先版本镜下来的卡没有参考图，
 * 不重算它们就永远停在「复用前先读一次详情」。收藏是本机的，展开详情补齐的产出比封面全，两样都留着。
 */
function refreshMirror(existing: TaskRecord, item: GenerationSummary): TaskRecord | null {
  if (!existing.remoteOnly) return null
  const next: TaskRecord = { ...taskFromGeneration(item), isFavorite: existing.isFavorite }
  if (existing.outputImages.length > next.outputImages.length) {
    next.outputImages = existing.outputImages
  }
  return JSON.stringify(existing) === JSON.stringify(next) ? null : next
}

/**
 * 平台记录里的状态与耗时。镜像卡的终态只有这一个来源，抄的时候必须连着抄：
 * 2026-09-21 详情已经读到 `completed`、只更新了产出与参考图，卡片就一直停在「生成中」。
 */
export function mirrorStatusPatch(
  item: GenerationSummary,
): Pick<TaskRecord, 'status' | 'error' | 'finishedAt' | 'elapsed'> {
  return {
    status: statusFromGeneration(item.status),
    error: item.errorType,
    finishedAt: item.completedAt,
    elapsed: item.completedAt && item.startedAt ? item.completedAt - item.startedAt : null,
  }
}

const watched = new Set<string>()

/**
 * 盯着平台上还在跑的那条生成，直到它落终态。镜像卡不是本机发起的，没有 `executeTask`
 * 那条连接可以等；不盯着它，卡片只能等下一次重读列表或展开详情才收尾。
 *
 * 轮询梯度与本机队列任务共用一份（最长 30 min）。超时仍未落终态就停手：平台侧的无主扫描
 * 会把它写成失败，下一次读列表或展开详情时照样能收尾，这里不替平台判死。
 */
export function watchMirroredGeneration(taskId: string): void {
  if (watched.has(taskId)) return
  watched.add(taskId)
  void pollMirroredGeneration(taskId).finally(() => watched.delete(taskId))
}

async function pollMirroredGeneration(taskId: string): Promise<void> {
  const { POLL_BACKOFF_MS, POLL_MAX_MS } = QUEUE_TIMEOUTS
  const deadline = Date.now() + POLL_MAX_MS
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    // apps/web 的 lib target 还没到 es2024，这里用不了 Promise.withResolvers。
    await new Promise((resolve) =>
      setTimeout(resolve, POLL_BACKOFF_MS[Math.min(attempt, POLL_BACKOFF_MS.length - 1)]),
    )
    const task = useStore.getState().tasks.find((item) => item.id === taskId)
    // 卡被删了，或者列表刷新 / 展开详情已经替它收过尾：这一轮就不用读了。
    if (!task?.remoteOnly || task.status !== 'running') return
    // 读不到（离线、5xx、临时 404）不算结论，下一轮再来。
    const detail = await readRemoteGeneration(taskId)
    if (!detail) continue
    const patch = mirrorStatusPatch(detail)
    if (patch.status === 'running') continue
    updateTaskInStore(taskId, {
      ...patch,
      outputImages:
        detail.outputs.length > 0
          ? detail.outputs.map((output) => mediaRef(output.mediaId))
          : task.outputImages,
    })
    return
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

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  PersistedSubmitRequest,
  VideoAspectRatio,
  VideoResolution,
} from '@image-playground/shared'
import { db, schema } from '../../db/client'
import { ffmpegRunner } from '../ffmpeg'
import { log } from '../logger'
import { objectStore } from '../objectStore'
import { AgentVideoTooLargeError, type ResolvedAgentVideo } from './images'
import {
  parseStitchProbe,
  STITCH_LIMITS,
  type StitchAdaptation,
  type StitchProbe,
  stitchAdaptations,
  stitchFfmpegArgs,
  stitchLimitRefusal,
  stitchProbeArgs,
  stitchTarget,
} from './video-stitch-plan'

/**
 * 拼接这件事的运行期：抢槽、落临时文件、探参数、跑 ffmpeg、把成片变成一件普通视频产物。
 * 算式全在 `video-stitch-plan.ts`，这里只负责按它说的做，并保证四条路径（成功、失败、
 * 超时、取消）都把临时目录删掉。
 */

/** 成片一律 mp4：它是 `<video>` 唯一到处都能播的容器。 */
const OUTPUT_MIME = 'video/mp4'

/** 成片落在这条假任务的产出位上，与生视频产物同一个键的形状。 */
const OUTPUT_INDEX = 0

/** 拼接不调上游模型，任务行上的模型名如实写它是谁干的。 */
export const STITCH_MODEL = 'ffmpeg-concat'

export type VideoStitchOutcome =
  | {
      readonly kind: 'stitched'
      readonly taskId: string
      readonly outputIndex: number
      readonly mime: string
      readonly width: number
      readonly height: number
      readonly durationSeconds: number
      readonly adaptations: readonly StitchAdaptation[]
    }
  /** 没拼成，但这不是异常：原因要如实说给模型听，由它转达用户。 */
  | { readonly kind: 'refused'; readonly message: string }

export interface VideoStitchInput {
  readonly videos: readonly ResolvedAgentVideo[]
  readonly userId: string | null
  readonly deviceId: string
  readonly conversationId: string
  readonly turnId: string
  readonly title: string
  readonly signal?: AbortSignal
  /**
   * 这次拼接的总墙钟预算，缺席即 `STITCH_LIMITS.totalBudgetMs`。**只有测试会缩短它**：
   * 生产上这个数字就是「一次拼接最多占住全局槽多久」。
   */
  readonly deadlineMs?: number
  /** 进了等待队列时报一声；面板复用「已排队」那一格。 */
  readonly onQueued?: () => void
  readonly onRunning?: () => void
}

/**
 * 全局一个槽。两条 1080p 重编码同时跑会把整个 BFF 的响应拖垮，而这台机器的 CPU 是共享的。
 * 等的人再多就直接回执「稍后再试」，不无限堆。
 */
const MAX_WAITING = 1
let slotBusy = false
interface Waiter {
  resume(): void
}
const waiting: Waiter[] = []

function releaseSlot(): void {
  const next = waiting.shift()
  // 直接交棒：中间不把 slotBusy 放回 false，否则新来的会插队。
  if (next) next.resume()
  else slotBusy = false
}

type SlotOutcome = 'acquired' | 'busy' | 'aborted'

async function acquireSlot(onQueued?: () => void, signal?: AbortSignal): Promise<SlotOutcome> {
  if (signal?.aborted) return 'aborted'
  if (!slotBusy) {
    slotBusy = true
    return 'acquired'
  }
  if (waiting.length >= MAX_WAITING) return 'busy'
  onQueued?.()
  return (await new Promise<boolean>((resolve) => {
    const waiter: Waiter = { resume: () => resolve(true) }
    waiting.push(waiter)
    // 等着的时候被取消就**让出等待位**：占着它不动，等于替一个已经不要结果的人
    // 把后面的人挡在门外。已经交棒到手上的那一刻之后再取消不走这条路，
    // 槽由调用方的 `finally` 还回去。
    signal?.addEventListener(
      'abort',
      () => {
        const at = waiting.indexOf(waiter)
        if (at < 0) return
        waiting.splice(at, 1)
        resolve(false)
      },
      { once: true },
    )
  }))
    ? 'acquired'
    : 'aborted'
}

/** 测试用：把槽复位，免得一个用例的等待者漏到下一个用例。 */
export function _resetVideoStitchSlotForTesting(): void {
  slotBusy = false
  waiting.length = 0
}

function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024))
}

function extensionFor(mime: string): string {
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('quicktime')) return 'mov'
  return 'mp4'
}

/** 成片的画幅与清晰度按实际像素就近归档；它只进任务行，不参与任何计价。 */
export function nearestAspectRatio(width: number, height: number): VideoAspectRatio {
  const ratio = width / height
  const candidates: ReadonlyArray<[VideoAspectRatio, number]> = [
    ['16:9', 16 / 9],
    ['9:16', 9 / 16],
    ['1:1', 1],
  ]
  return candidates.reduce((best, candidate) =>
    Math.abs(candidate[1] - ratio) < Math.abs(best[1] - ratio) ? candidate : best,
  )[0]
}

export function nearestResolution(height: number): VideoResolution {
  if (height >= 1_300) return '2k'
  if (height >= 900) return '1080p'
  return '720p'
}

/**
 * 成片是一条**出生即 completed** 的任务行：没经过 `createQueueTask` 就没有预扣，
 * 没经过 `finishTask` / `cancelTasks` 就没有结算——私有计费账本里不会有它的任何痕迹。
 * 这才是「0 积分」的准确含义（见 ADR 0009）。
 */
async function storeStitchedVideo(input: {
  readonly bytes: Uint8Array
  readonly durationSeconds: number
  readonly width: number
  readonly height: number
  readonly userId: string | null
  readonly deviceId: string
  readonly conversationId: string
  readonly turnId: string
  readonly prompt: string
}): Promise<string> {
  const taskId = crypto.randomUUID()
  const objectKey = `${taskId}/out/${OUTPUT_INDEX}`
  await objectStore().write(objectKey, input.bytes, OUTPUT_MIME)
  const now = Date.now()
  const requestPayload: PersistedSubmitRequest = {
    prompt: input.prompt,
    device_id: input.deviceId,
    n: 1,
    // 带上 video 这一段，成片就与逐镜产出同类：同样不进 generation_records，同样按视频清理。
    video: {
      duration_seconds: Math.max(1, Math.round(input.durationSeconds)),
      aspect_ratio: nearestAspectRatio(input.width, input.height),
      resolution: nearestResolution(input.height),
    },
  }
  try {
    await db.insert(schema.tasks).values({
      id: taskId,
      provider: 'openai-compat',
      model: STITCH_MODEL,
      status: 'completed',
      request_payload: requestPayload,
      result_payload: {
        data: [
          {
            object: objectKey,
            mime: OUTPUT_MIME,
            duration_seconds: input.durationSeconds,
            width: input.width,
            height: input.height,
          },
        ],
      },
      submitted_at: now,
      started_at: now,
      completed_at: now,
      user_id: input.userId,
      agent_conversation_id: input.conversationId,
      agent_turn_id: input.turnId,
    })
  } catch (error) {
    // 行没落成，桶里那份就是孤儿；删不掉也只是留给 bucket lifecycle。
    await objectStore()
      .deletePrefix(`${taskId}/`)
      .catch(() => {})
    throw error
  }
  return taskId
}

/** 探一段片子的参数。读不出来的那一段要点名，模型才知道该换哪一个 id。 */
async function probeSegment(
  path: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<StitchProbe | null> {
  const result = await ffmpegRunner().ffprobe(stitchProbeArgs(path), {
    timeoutMs,
    ...(signal ? { signal } : {}),
  })
  if (result.code !== 0) return null
  return parseStitchProbe(result.stdout)
}

const CANCELLED = '这一轮被中止了'
const OUT_OF_TIME = `这次拼接跑了太久（上限 ${Math.round(STITCH_LIMITS.totalBudgetMs / 1000)} 秒），已经停下。段少一点或者短一点再试。`

export async function stitchVideoSegments(input: VideoStitchInput): Promise<VideoStitchOutcome> {
  // 段数与「任务行上声明的总时长」在**下载之前**就问一遍：不该被拉下来的东西，
  // 不要先花几百 MB 的网络与磁盘再说。
  const declared = stitchLimitRefusal(input.videos.map((one) => one.declaredDurationSeconds))
  if (declared) return { kind: 'refused', message: declared }

  const slot = await acquireSlot(input.onQueued, input.signal)
  if (slot === 'busy') {
    return {
      kind: 'refused',
      message: '这台机器同一时刻只拼一条视频，现在排不下。等前面那条拼完再试，几分钟内就行。',
    }
  }
  if (slot === 'aborted') return { kind: 'refused', message: CANCELLED }

  // 预算从**拿到槽**开始算：排队等的那段时间不是这次拼接的活，但它占住槽的时间必须封顶。
  const deadline = Date.now() + (input.deadlineMs ?? STITCH_LIMITS.totalBudgetMs)
  const remaining = () => deadline - Date.now()
  let workspace: string | undefined
  try {
    if (input.signal?.aborted) return { kind: 'refused', message: CANCELLED }
    input.onRunning?.()
    workspace = await mkdtemp(join(tmpdir(), 'aip-stitch-'))
    const inputPaths: string[] = []
    for (const [index, video] of input.videos.entries()) {
      if (input.signal?.aborted) return { kind: 'refused', message: CANCELLED }
      if (remaining() <= 0) return { kind: 'refused', message: OUT_OF_TIME }
      const path = join(workspace, `in-${index}.${extensionFor(video.mime)}`)
      try {
        await video.writeTo(path, STITCH_LIMITS.maxSegmentBytes)
      } catch (error) {
        if (!(error instanceof AgentVideoTooLargeError)) throw error
        return {
          kind: 'refused',
          message: `第 ${index + 1} 段（${video.videoId}）太大，超过单段 ${megabytes(STITCH_LIMITS.maxSegmentBytes)} MB 的上限，这次没有拼接。`,
        }
      }
      inputPaths.push(path)
    }
    if (input.signal?.aborted) return { kind: 'refused', message: CANCELLED }

    const probes: StitchProbe[] = []
    for (const [index, path] of inputPaths.entries()) {
      const budget = Math.min(remaining(), STITCH_LIMITS.probeTimeoutMs)
      if (budget <= 0) return { kind: 'refused', message: OUT_OF_TIME }
      const probe = await probeSegment(path, budget, input.signal)
      if (input.signal?.aborted) return { kind: 'refused', message: CANCELLED }
      if (!probe) {
        return {
          kind: 'refused',
          message: `第 ${index + 1} 段（${input.videos[index]!.videoId}）读不出视频参数，可能不是一段完整的视频。换一个视频 id 再试。`,
        }
      }
      probes.push(probe)
    }
    // 真时长再问一遍：任务行声明的那个可能缺席，也可能与成片对不上。
    const refusal = stitchLimitRefusal(probes.map((probe) => probe.durationSeconds))
    if (refusal) return { kind: 'refused', message: refusal }

    const target = stitchTarget(probes)
    const outputPath = join(workspace, 'out.mp4')
    const budget = remaining()
    if (budget <= 0) return { kind: 'refused', message: OUT_OF_TIME }
    const result = await ffmpegRunner().ffmpeg(
      stitchFfmpegArgs({ inputPaths, probes, target, outputPath }),
      { timeoutMs: budget, ...(input.signal ? { signal: input.signal } : {}) },
    )
    if (input.signal?.aborted) return { kind: 'refused', message: CANCELLED }
    if (result.code !== 0) {
      log.warn(
        {
          event: 'agent.stitch_failed',
          conversationId: input.conversationId,
          turnId: input.turnId,
          code: result.code,
          timedOut: remaining() <= 0,
          err: result.stderr,
        },
        'ffmpeg concat failed',
      )
      return {
        kind: 'refused',
        message:
          remaining() <= 0
            ? OUT_OF_TIME
            : '拼接没能完成：这几段视频的参数差得太多，ffmpeg 接不起来。把它们如实告诉用户，不要假装已经交付。',
      }
    }
    const film = Bun.file(outputPath)
    // 先问大小再读：成片仍要整份进内存才能交给对象存储（见 ADR 0009 的已知债），
    // 所以那一份必须先封顶。
    if (film.size > STITCH_LIMITS.maxFilmBytes) {
      return {
        kind: 'refused',
        message: `拼出来的成片超过 ${megabytes(STITCH_LIMITS.maxFilmBytes)} MB，没有保存。段少一点或者短一点再试。`,
      }
    }
    if (film.size === 0) {
      return { kind: 'refused', message: '拼接跑完了却没有成片，这次不算交付。' }
    }
    const bytes = new Uint8Array(await film.arrayBuffer())
    const durationSeconds = probes.reduce((sum, probe) => sum + probe.durationSeconds, 0)
    const taskId = await storeStitchedVideo({
      bytes,
      durationSeconds,
      width: target.width,
      height: target.height,
      userId: input.userId,
      deviceId: input.deviceId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      prompt: input.title,
    })
    log.info(
      {
        event: 'agent.stitch_completed',
        conversationId: input.conversationId,
        turnId: input.turnId,
        taskId,
        segments: probes.length,
        durationSeconds,
        bytes: bytes.byteLength,
      },
      'stitched video stored',
    )
    return {
      kind: 'stitched',
      taskId,
      outputIndex: OUTPUT_INDEX,
      mime: OUTPUT_MIME,
      width: target.width,
      height: target.height,
      durationSeconds,
      adaptations: stitchAdaptations(probes, target),
    }
  } finally {
    // 成功、失败、超时、取消四条路共用这一次清理。
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {})
    releaseSlot()
  }
}

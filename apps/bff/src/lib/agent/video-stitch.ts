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
import type { ResolvedAgentVideo } from './images'
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
const waiting: Array<() => void> = []

function releaseSlot(): void {
  const next = waiting.shift()
  // 直接交棒：中间不把 slotBusy 放回 false，否则新来的会插队。
  if (next) next()
  else slotBusy = false
}

async function acquireSlot(onQueued?: () => void): Promise<boolean> {
  if (!slotBusy) {
    slotBusy = true
    return true
  }
  if (waiting.length >= MAX_WAITING) return false
  onQueued?.()
  await new Promise<void>((resolve) => waiting.push(resolve))
  return true
}

/** 测试用：把槽复位，免得一个用例的等待者漏到下一个用例。 */
export function _resetVideoStitchSlotForTesting(): void {
  slotBusy = false
  waiting.length = 0
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
async function probeSegment(path: string, signal?: AbortSignal): Promise<StitchProbe | null> {
  const result = await ffmpegRunner().ffprobe(stitchProbeArgs(path), {
    timeoutMs: STITCH_LIMITS.timeoutMs,
    ...(signal ? { signal } : {}),
  })
  if (result.code !== 0) return null
  return parseStitchProbe(result.stdout)
}

export async function stitchVideoSegments(input: VideoStitchInput): Promise<VideoStitchOutcome> {
  if (!(await acquireSlot(input.onQueued))) {
    return {
      kind: 'refused',
      message: '这台机器同一时刻只拼一条视频，现在排不下。等前面那条拼完再试，几分钟内就行。',
    }
  }
  let workspace: string | undefined
  try {
    if (input.signal?.aborted) return { kind: 'refused', message: '这一轮被中止了' }
    input.onRunning?.()
    workspace = await mkdtemp(join(tmpdir(), 'aip-stitch-'))
    const inputPaths: string[] = []
    for (const [index, video] of input.videos.entries()) {
      const path = join(workspace, `in-${index}.${extensionFor(video.mime)}`)
      await writeFile(path, await video.read())
      inputPaths.push(path)
    }
    const probes: StitchProbe[] = []
    for (const [index, path] of inputPaths.entries()) {
      const probe = await probeSegment(path, input.signal)
      if (!probe) {
        return {
          kind: 'refused',
          message: `第 ${index + 1} 段（${input.videos[index]!.videoId}）读不出视频参数，可能不是一段完整的视频。换一个视频 id 再试。`,
        }
      }
      probes.push(probe)
    }
    const refusal = stitchLimitRefusal(probes)
    if (refusal) return { kind: 'refused', message: refusal }

    const target = stitchTarget(probes)
    const outputPath = join(workspace, 'out.mp4')
    const result = await ffmpegRunner().ffmpeg(
      stitchFfmpegArgs({ inputPaths, probes, target, outputPath }),
      { timeoutMs: STITCH_LIMITS.timeoutMs, ...(input.signal ? { signal: input.signal } : {}) },
    )
    if (input.signal?.aborted) return { kind: 'refused', message: '这一轮被中止了' }
    if (result.code !== 0) {
      log.warn(
        {
          event: 'agent.stitch_failed',
          conversationId: input.conversationId,
          turnId: input.turnId,
          code: result.code,
          err: result.stderr,
        },
        'ffmpeg concat failed',
      )
      return {
        kind: 'refused',
        message:
          '拼接没能完成：这几段视频的参数差得太多，ffmpeg 接不起来。把它们如实告诉用户，不要假装已经交付。',
      }
    }
    const bytes = new Uint8Array(await Bun.file(outputPath).arrayBuffer())
    if (bytes.byteLength === 0) {
      return { kind: 'refused', message: '拼接跑完了却没有成片，这次不算交付。' }
    }
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

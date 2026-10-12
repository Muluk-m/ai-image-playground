import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { log } from '../logger'

/**
 * 对话模型只收图片，不收 mp4。抽帧口径见
 * docs/research/agent-video-reading-2026-10-12.md：短片大约每秒 1 帧，最多 8 帧，每帧带时间。
 * 这里只出几张缩小的 JPEG。`-ss` 放在 `-i` 之后，短片才不会被关键帧吸附到错误的时间。
 * 不重编码成片（ADR 0010）。
 */
const END_MARGIN_SECONDS = 0.04
const ONE_SECOND = 1
const FRAME_CAP = 8
const SAMPLE_TIMEOUT_MS = 45_000
const PREVIEW_EDGE = 1024

export const VIDEO_FRAMES_UNAVAILABLE = '这段视频暂时抽不出画面，请稍后再试。'

export class VideoUnreadable extends Error {
  readonly userMessage = VIDEO_FRAMES_UNAVAILABLE
  constructor(cause?: unknown) {
    super(VIDEO_FRAMES_UNAVAILABLE, cause === undefined ? undefined : { cause })
    this.name = 'VideoUnreadable'
  }
}

export interface VideoFrame {
  readonly timeSeconds: number
  readonly jpeg: Uint8Array
}

export interface SampledFrames {
  readonly durationSeconds: number
  readonly intervalSeconds: number
  readonly frames: readonly VideoFrame[]
}

export interface FramePlan {
  readonly times: readonly number[]
  readonly intervalSeconds: number
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** 能按 1 秒一帧放下就按 1 秒；更长则均匀取 8 帧，含开头和临近结尾。 */
export function framePlan(durationSeconds: number): FramePlan {
  if (!(durationSeconds > END_MARGIN_SECONDS)) return { times: [0], intervalSeconds: 0 }
  const last = round3(durationSeconds - END_MARGIN_SECONDS)
  const intervalSeconds = last <= FRAME_CAP - 1 ? ONE_SECOND : last / (FRAME_CAP - 1)
  const times = [0]
  let step = 1
  while (times.length < FRAME_CAP - 1 && step * intervalSeconds < last - intervalSeconds * 0.25) {
    const next = round3(step * intervalSeconds)
    if (next !== times[times.length - 1]) times.push(next)
    step += 1
  }
  if (times[times.length - 1] !== last) times.push(last)
  return { times, intervalSeconds }
}

export function frameTimestamps(durationSeconds: number): readonly number[] {
  return framePlan(durationSeconds).times
}

type VideoSampler = (bytes: Uint8Array, durationHint?: number) => Promise<SampledFrames>

async function runCommand(
  bin: string,
  args: readonly string[],
  signal: AbortSignal,
  captureStdout: boolean,
): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    signal,
  })
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  let stderrBytes = 0
  child.stdout?.on('data', (chunk: Buffer) => {
    if (captureStdout) stdoutChunks.push(chunk)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderrBytes >= 2_000) return
    stderrChunks.push(chunk)
    stderrBytes += chunk.length
  })
  const code = await new Promise<number>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      callback()
    }
    child.once('error', (error) => finish(() => reject(error)))
    child.once('close', (exitCode) => finish(() => resolve(exitCode ?? 1)))
  })
  const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, 500)
  if (code !== 0) {
    const error = new Error(`${bin} exited ${code}`) as Error & { stderr?: string }
    error.stderr = stderr
    throw error
  }
  return { stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr }
}

function usableDuration(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function frameSeconds(rate: string | undefined): number {
  const match = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(rate ?? '')
  if (!match) return 1 / 24
  const fps = Number(match[1]) / Number(match[2])
  return fps >= 1 && fps <= 240 ? 1 / fps : 1 / 24
}

async function probeClip(
  input: string,
  signal: AbortSignal,
): Promise<{ duration?: number; frameSeconds: number }> {
  const { stdout } = await runCommand(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=avg_frame_rate:format=duration',
      '-of',
      'json',
      input,
    ],
    signal,
    true,
  )
  const parsed = JSON.parse(stdout) as {
    streams?: { avg_frame_rate?: string }[]
    format?: { duration?: string }
  }
  return {
    duration: usableDuration(Number(parsed.format?.duration)),
    frameSeconds: frameSeconds(parsed.streams?.[0]?.avg_frame_rate),
  }
}

async function extractJpeg(
  input: string,
  timeSeconds: number,
  output: string,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  await rm(output, { force: true })
  await runCommand(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-i',
      input,
      '-ss',
      String(timeSeconds),
      '-frames:v',
      '1',
      '-an',
      '-vf',
      // 逗号在滤镜图里是分隔符，所以写在表达式里要转义。只缩小，不把小图放大。
      `scale=min(${PREVIEW_EDGE}\\,iw):min(${PREVIEW_EDGE}\\,ih):force_original_aspect_ratio=decrease`,
      '-q:v',
      '5',
      // ffmpeg 8 拒绝有限范围的 mjpeg，不放开这一档就抽不出 JPEG。
      '-strict',
      'unofficial',
      '-y',
      output,
    ],
    signal,
    false,
  )
  try {
    const jpeg = await readFile(output)
    return jpeg.byteLength >= 3 && jpeg[0] === 0xff && jpeg[1] === 0xd8 ? jpeg : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function sampleWithFfmpeg(bytes: Uint8Array, durationHint?: number): Promise<SampledFrames> {
  const directory = await mkdtemp(join(tmpdir(), 'aip-video-frames-'))
  const input = join(directory, 'clip.bin')
  const signal = AbortSignal.timeout(SAMPLE_TIMEOUT_MS)
  try {
    await writeFile(input, bytes)
    const probed = await probeClip(input, signal)
    const hinted = usableDuration(durationHint)
    const durationSeconds =
      hinted && probed.duration ? Math.min(hinted, probed.duration) : (hinted ?? probed.duration)
    if (durationSeconds === undefined) throw new Error('duration missing')
    // 末帧时间戳落在最后一帧之前。固定 0.04 秒在低帧率上会指到片子结束之后，ffmpeg 退出 0 但不写文件。
    const endPad = Math.max(probed.frameSeconds, END_MARGIN_SECONDS)
    const plan = framePlan(Math.max(endPad, durationSeconds - endPad + END_MARGIN_SECONDS))
    const frames: VideoFrame[] = []
    for (const [index, timeSeconds] of plan.times.entries()) {
      const output = join(directory, `frame-${index}.jpg`)
      const jpeg = await extractJpeg(input, timeSeconds, output, signal)
      const fallbackTime = round3(Math.max(0, timeSeconds - endPad))
      const fallback =
        jpeg || fallbackTime === timeSeconds
          ? undefined
          : await extractJpeg(input, fallbackTime, output, signal)
      const still = jpeg ?? fallback
      if (!still) throw new Error('frame missing')
      const used = jpeg ? timeSeconds : fallbackTime
      const previous = frames[frames.length - 1]?.timeSeconds
      if (previous !== undefined && used <= previous) continue
      frames.push({ timeSeconds: used, jpeg: still })
    }
    if (frames.length === 0) throw new Error('no frames')
    return { durationSeconds, intervalSeconds: plan.intervalSeconds, frames }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    log.warn(
      { err: error, event: 'agent.video_frames_failed', ...(code ? { code } : {}) },
      'viewVideo frame sample failed',
    )
    throw new VideoUnreadable(error)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

let sampler: VideoSampler = sampleWithFfmpeg

/** 测试注入抽帧结果。传 null 恢复真的 ffmpeg。 */
export function setVideoSamplerForTesting(next: VideoSampler | null): void {
  sampler = next ?? sampleWithFfmpeg
}

export function sampleVideo(bytes: Uint8Array, durationHint?: number): Promise<SampledFrames> {
  return sampler(bytes, durationHint)
}

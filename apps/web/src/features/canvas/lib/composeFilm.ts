import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
} from 'mediabunny'
import { clipFrameCount, FILM_FPS, FILM_MAX_SECONDS, FILM_SAMPLE_RATE, fitAudio } from './filmSpec'

export interface ComposeClip {
  blob: Blob
  in: number
  out?: number
  /** 主线程解码好的 48 kHz 平面声道，从入点开始；没有音轨为空数组。 */
  audio: Float32Array[]
}

export type ComposeFailure = 'tooLong' | 'unreadable'

export class ComposeError extends Error {
  constructor(
    readonly reason: ComposeFailure,
    readonly position?: number,
  ) {
    super(reason)
  }
}

/** H.264 要求宽高为偶数。 */
function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2)
}

/**
 * 按顺序把各段拼成一条 mp4：画面按第一段的尺寸，比例不同的等比居中加黑边；
 * 时间轴按输出帧号计，不用源帧时间戳（源帧率低于 30 时同一源帧会取多次）。
 * onProgress 收到 0–1。
 */
export async function composeFilm(
  clips: readonly ComposeClip[],
  onProgress: (fraction: number) => void,
): Promise<ArrayBuffer> {
  const inputs = clips.map(
    (clip) => new Input({ formats: ALL_FORMATS, source: new BlobSource(clip.blob) }),
  )
  const tracks = await Promise.all(
    inputs.map(async (input, index) => {
      const track = await input.getPrimaryVideoTrack().catch(() => null)
      if (!track || !(await track.canDecode())) throw new ComposeError('unreadable', index + 1)
      return { track, seconds: await input.computeDuration() }
    }),
  )
  const frameCounts = tracks.map((t, index) => clipFrameCount(clips[index]!, t.seconds, FILM_FPS))
  const totalFrames = frameCounts.reduce((sum, n) => sum + n, 0)
  if (totalFrames / FILM_FPS > FILM_MAX_SECONDS + 1) throw new ComposeError('tooLong')

  const width = even(tracks[0]!.track.displayWidth)
  const height = even(tracks[0]!.track.displayHeight)
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')!
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  })
  // Safari 默认（quality）模式编到第 5～8 帧后不再产出，实时模式两家都能跑完（ADR 0010）。
  const video = new CanvasSource(canvas, {
    codec: 'avc',
    quality: QUALITY_HIGH,
    latencyMode: 'realtime',
  })
  const audio = new AudioSampleSource({ codec: 'aac', bitrate: 128e3 })
  output.addVideoTrack(video, { frameRate: FILM_FPS })
  output.addAudioTrack(audio)
  await output.start()

  let written = 0
  try {
    for (let i = 0; i < clips.length; i += 1) {
      const clip = clips[i]!
      const { track } = tracks[i]!
      const frames = frameCounts[i]!
      const offset = written / FILM_FPS
      const times = Array.from({ length: frames }, (_, k) => clip.in + k / FILM_FPS)
      let k = 0
      for await (const got of new CanvasSink(track, { poolSize: 2 }).canvasesAtTimestamps(times)) {
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, width, height)
        if (got) {
          const { width: sw, height: sh } = got.canvas
          const scale = Math.min(width / sw, height / sh)
          const w = sw * scale
          const h = sh * scale
          ctx.drawImage(got.canvas, (width - w) / 2, (height - h) / 2, w, h)
        }
        await video.add(offset + k / FILM_FPS, 1 / FILM_FPS)
        k += 1
        written += 1
        if (written % 15 === 0) onProgress(written / totalFrames)
      }
      // 音频按画面帧数定长，缺的补静音，每段首尾都对齐画面。
      const audioFrames = Math.round((frames / FILM_FPS) * FILM_SAMPLE_RATE)
      const sample = new AudioSample({
        data: fitAudio(clip.audio, audioFrames),
        format: 'f32-planar',
        numberOfChannels: 2,
        sampleRate: FILM_SAMPLE_RATE,
        timestamp: offset,
      })
      await audio.add(sample)
      sample.close()
    }
    await output.finalize()
  } catch (err) {
    await output.cancel().catch(() => {})
    throw err
  } finally {
    for (const input of inputs) input.dispose()
  }
  onProgress(1)
  return (output.target as BufferTarget).buffer!
}

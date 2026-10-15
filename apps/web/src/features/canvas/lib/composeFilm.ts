import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSource,
  BlobSource,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  type Target,
} from 'mediabunny'
import {
  clipFrameCount,
  FILM_FPS,
  FILM_MAX_CLIPS,
  FILM_MAX_SECONDS,
  FILM_SAMPLE_RATE,
  fitAudio,
} from './filmSpec'

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
  count: number,
  loadClip: (index: number) => Promise<ComposeClip>,
  target: Target,
  onProgress: (fraction: number) => void,
): Promise<void> {
  if (!Number.isInteger(count) || count < 1 || count > FILM_MAX_CLIPS)
    throw new ComposeError('tooLong')
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target,
  })
  let video: CanvasSource | undefined
  let canvas: OffscreenCanvas | undefined
  const audio = new AudioSampleSource({ codec: 'aac', bitrate: 128e3 })
  let written = 0
  try {
    for (let i = 0; i < count; i += 1) {
      const clip = await loadClip(i)
      const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(clip.blob) })
      try {
        const track = await input.getPrimaryVideoTrack().catch(() => null)
        if (!track || !(await track.canDecode())) throw new ComposeError('unreadable', i + 1)
        const frames = clipFrameCount(clip, await input.computeDuration(), FILM_FPS)
        if ((written + frames) / FILM_FPS > FILM_MAX_SECONDS) throw new ComposeError('tooLong')
        if (!canvas) {
          canvas = new OffscreenCanvas(even(track.displayWidth), even(track.displayHeight))
          // Safari quality 模式会卡住；继续使用 ADR 0010 已验收的 realtime 模式。
          video = new CanvasSource(canvas, {
            codec: 'avc',
            quality: QUALITY_HIGH,
            latencyMode: 'realtime',
          })
          output.addVideoTrack(video, { frameRate: FILM_FPS })
          output.addAudioTrack(audio)
          await output.start()
        }
        const { width, height } = canvas
        const ctx = canvas.getContext('2d')!
        const offset = written / FILM_FPS
        const times = Array.from({ length: frames }, (_, k) => clip.in + k / FILM_FPS)
        let k = 0
        for await (const got of new CanvasSink(track, { poolSize: 2 }).canvasesAtTimestamps(
          times,
        )) {
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, width, height)
          if (got) {
            const { width: sw, height: sh } = got.canvas
            const scale = Math.min(width / sw, height / sh)
            const w = sw * scale,
              h = sh * scale
            ctx.drawImage(got.canvas, (width - w) / 2, (height - h) / 2, w, h)
          }
          await video!.add(offset + k / FILM_FPS, 1 / FILM_FPS)
          k += 1
          written += 1
          if (written % 15 === 0) onProgress((i + k / frames) / count)
        }
        const sample = new AudioSample({
          data: fitAudio(clip.audio, Math.round((frames / FILM_FPS) * FILM_SAMPLE_RATE)),
          format: 'f32-planar',
          numberOfChannels: 2,
          sampleRate: FILM_SAMPLE_RATE,
          timestamp: offset,
        })
        try {
          await audio.add(sample)
        } finally {
          sample.close()
        }
      } finally {
        input.dispose()
      }
    }
    await output.finalize()
  } catch (err) {
    await output.cancel().catch(() => {})
    throw err
  }
  onProgress(1)
}

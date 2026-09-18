/** 成片规格与纯计算，不引应用代码：Worker 也要用它。 */

/** 成片上限（ADR 0010）：成片整段放在内存里，超出就不保证浏览器扛得住。 */
export const FILM_MAX_CLIPS = 8
export const FILM_MAX_SECONDS = 180
/** 成片规格：固定 30 fps，音频 48 kHz 双声道。 */
export const FILM_FPS = 30
export const FILM_SAMPLE_RATE = 48000

/** 成片里的一段：源片是哪个任务的第几个产物，从哪一秒播到哪一秒。出点缺省播到结尾。 */
export interface FilmClip {
  taskId: string
  outputIndex: number
  in: number
  out?: number
}

/**
 * 把一段已解码的音频（48 kHz 平面声道）裁成正好 frames 帧：不够的补静音，多的截掉，
 * 单声道复制成两路。音频按画面帧数定长，拼接后才不会一段段累积出音画错位。
 */
export function fitAudio(channels: readonly Float32Array[], frames: number): Float32Array {
  const out = new Float32Array(frames * 2)
  if (channels.length === 0) return out
  for (let ch = 0; ch < 2; ch += 1) {
    const source = channels[Math.min(ch, channels.length - 1)]!
    out.set(source.subarray(0, frames), ch * frames)
  }
  return out
}

/** 一段在成片里占多少帧：按入出点与文件真实时长取交集，至少一帧。 */
export function clipFrameCount(
  clip: Pick<FilmClip, 'in' | 'out'>,
  fileSeconds: number,
  fps: number,
): number {
  const end = Math.min(clip.out ?? fileSeconds, fileSeconds)
  return Math.max(1, Math.floor(Math.max(0, end - clip.in) * fps))
}

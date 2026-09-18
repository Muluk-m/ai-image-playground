import type { CanvasEl, TimelineClip } from './canvasDoc'
import { FILM_MAX_CLIPS, FILM_MAX_SECONDS, type FilmClip } from './filmSpec'
import { isTimelineSource, timelineSeconds } from './timeline'

export type FilmRefusal =
  | { kind: 'empty' }
  /** 第几段（从 1 数）的源视频已经不在画布上。 */
  | { kind: 'missing'; position: number }
  | { kind: 'tooMany'; max: number }
  | { kind: 'tooLong'; maxSeconds: number }

export type FilmPlan = { ok: true; clips: FilmClip[] } | { ok: false; refusal: FilmRefusal }

/**
 * 一条时间线能不能导出、导出哪些片段。时长按画布上已知的源片时长估；
 * 未知时长的旧视频按占位时长计，真实时长到合成时再以文件为准。
 * `limits: false` 给「下载全部片段」用：原片打包不重编码，不受段数与时长上限约束。
 */
export function planFilm(
  clips: readonly TimelineClip[],
  lookup: (id: string) => CanvasEl | undefined,
  { limits = true }: { limits?: boolean } = {},
): FilmPlan {
  if (clips.length === 0) return { ok: false, refusal: { kind: 'empty' } }
  const missing = clips.findIndex((clip) => !isTimelineSource(lookup(clip.elementId)))
  if (missing >= 0) return { ok: false, refusal: { kind: 'missing', position: missing + 1 } }
  if (!limits) return { ok: true, clips: toFilmClips(clips, lookup) }
  if (clips.length > FILM_MAX_CLIPS)
    return { ok: false, refusal: { kind: 'tooMany', max: FILM_MAX_CLIPS } }
  if (timelineSeconds(clips, lookup) > FILM_MAX_SECONDS)
    return { ok: false, refusal: { kind: 'tooLong', maxSeconds: FILM_MAX_SECONDS } }
  return { ok: true, clips: toFilmClips(clips, lookup) }
}

function toFilmClips(
  clips: readonly TimelineClip[],
  lookup: (id: string) => CanvasEl | undefined,
): FilmClip[] {
  return clips.map((clip) => {
    // 调用前已确认每段都是带视频的图片元素。
    const { video } = lookup(clip.elementId) as Extract<CanvasEl, { type: 'image' }>
    return {
      taskId: video!.taskId,
      outputIndex: video!.outputIndex,
      in: clip.in,
      ...(clip.out === undefined ? {} : { out: clip.out }),
    }
  })
}

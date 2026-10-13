import { describe, expect, it } from 'vitest'
import type { CanvasEl, TimelineClip } from '../../../../features/canvas/lib/canvasDoc'
import { planFilm } from '../../../../features/canvas/lib/filmPlan'
import {
  clipFrameCount,
  FILM_MAX_CLIPS,
  FILM_MAX_SECONDS,
  fitAudio,
} from '../../../../features/canvas/lib/filmSpec'

function video(id: string, duration?: number): CanvasEl {
  return {
    id,
    type: 'image',
    x: 0,
    y: 0,
    width: 160,
    height: 90,
    rotation: 0,
    fileId: `file-${id}`,
    video: {
      taskId: `task-${id}`,
      outputIndex: 1,
      ...(duration
        ? { generation: { model: 'm', duration, aspectRatio: '16:9', resolution: '720p' } }
        : {}),
    },
  }
}

function lookupOf(elements: CanvasEl[]) {
  const byId = new Map(elements.map((el) => [el.id, el]))
  return (id: string) => byId.get(id)
}

describe('planFilm', () => {
  it('maps clips to their source outputs with in/out points', () => {
    const lookup = lookupOf([video('a', 8), video('b')])
    const clips: TimelineClip[] = [
      { elementId: 'a', in: 1, out: 6 },
      { elementId: 'b', in: 0 },
    ]
    expect(planFilm(clips, lookup)).toEqual({
      ok: true,
      clips: [
        { taskId: 'task-a', outputIndex: 1, in: 1, out: 6 },
        { taskId: 'task-b', outputIndex: 1, in: 0 },
      ],
    })
  })

  it('refuses an empty timeline', () => {
    expect(planFilm([], lookupOf([]))).toEqual({ ok: false, refusal: { kind: 'empty' } })
  })

  it('names the first clip whose source left the canvas', () => {
    const plan = planFilm(
      [
        { elementId: 'a', in: 0, out: 5 },
        { elementId: 'gone', in: 0, out: 5 },
      ],
      lookupOf([video('a', 5)]),
    )
    expect(plan).toEqual({ ok: false, refusal: { kind: 'missing', position: 2 } })
  })

  it('refuses more clips than the film limit', () => {
    const elements = Array.from({ length: FILM_MAX_CLIPS + 1 }, (_, i) => video(`v${i}`, 4))
    const clips = elements.map((el) => ({ elementId: el.id, in: 0, out: 4 }))
    expect(planFilm(clips, lookupOf(elements))).toEqual({
      ok: false,
      refusal: { kind: 'tooMany', max: FILM_MAX_CLIPS },
    })
  })

  it('refuses a film longer than the limit', () => {
    const elements = [video('a', FILM_MAX_SECONDS), video('b', 1)]
    const clips = elements.map((el) => ({ elementId: el.id, in: 0, out: FILM_MAX_SECONDS }))
    expect(planFilm(clips, lookupOf(elements))).toEqual({
      ok: false,
      refusal: { kind: 'tooLong', maxSeconds: FILM_MAX_SECONDS },
    })
  })
})

describe('fitAudio', () => {
  it('pads with silence and duplicates mono into two planar channels', () => {
    const out = fitAudio([Float32Array.from([1, 2])], 3)
    expect(Array.from(out)).toEqual([1, 2, 0, 1, 2, 0])
  })

  it('truncates longer audio to the frame count', () => {
    const out = fitAudio([Float32Array.from([1, 2, 3]), Float32Array.from([4, 5, 6])], 2)
    expect(Array.from(out)).toEqual([1, 2, 4, 5])
  })

  it('returns silence when the clip has no audio', () => {
    expect(Array.from(fitAudio([], 2))).toEqual([0, 0, 0, 0])
  })
})

describe('clipFrameCount', () => {
  it('plays to the file end when the out point is open or past the end', () => {
    expect(clipFrameCount({ in: 1 }, 5, 30)).toBe(120)
    expect(clipFrameCount({ in: 0, out: 9 }, 5, 30)).toBe(150)
  })

  it('keeps at least one frame', () => {
    expect(clipFrameCount({ in: 5, out: 5 }, 5, 30)).toBe(1)
  })
})

it('retains the durable original when resolving a timeline clip', () => {
  const source = video('adopted', 5)
  if (source.type !== 'image' || !source.video) throw new Error('fixture')
  source.video.mediaId = '11111111-1111-4111-8111-111111111111'
  expect(planFilm([{ elementId: source.id, in: 1, out: 4 }], lookupOf([source]))).toMatchObject({
    ok: true,
    clips: [{ mediaId: source.video.mediaId, in: 1, out: 4 }],
  })
})

it('accepts 64 clips spanning ten minutes', () => {
  const elements = Array.from({ length: 64 }, (_, i) => video(`v${i}`, 9.375))
  const clips = elements.map((el) => ({ elementId: el.id, in: 0, out: 9.375 }))
  expect(planFilm(clips, lookupOf(elements)).ok).toBe(true)
})

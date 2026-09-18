import { describe, expect, it } from 'vitest'
import {
  clipRange,
  locateTime,
  MIN_CLIP_SECONDS,
  moveClip,
  removeClip,
  startOfClip,
  totalDuration,
  trimClip,
} from '../../../../features/canvas/lib/timelineEdit'

const clips = [
  { elementId: 'a', in: 0, out: 4 },
  { elementId: 'b', in: 1, out: 6 },
  { elementId: 'c', in: 0 },
]
const sources: Record<string, number | undefined> = { a: 8, b: 10, c: 3 }
const sourceOf = (id: string) => sources[id]

describe('时间线编辑', () => {
  it('reorders by moving one clip to a new index', () => {
    expect(moveClip(clips, 2, 0).map((one) => one.elementId)).toEqual(['c', 'a', 'b'])
    expect(moveClip(clips, 0, 2).map((one) => one.elementId)).toEqual(['b', 'c', 'a'])
    expect(moveClip(clips, 1, 1)).toEqual(clips)
  })

  it('removes a clip', () => {
    expect(removeClip(clips, 1).map((one) => one.elementId)).toEqual(['a', 'c'])
  })

  it('plays to the source end when there is no out point', () => {
    expect(clipRange(clips[2]!, 3)).toEqual({ in: 0, out: 3 })
  })

  it('trims the in point within the source and at least half a second before the out point', () => {
    expect(trimClip(clips[0]!, 'in', 1.5, 8)).toMatchObject({ in: 1.5, out: 4 })
    expect(trimClip(clips[0]!, 'in', 3.9, 8)).toMatchObject({ in: 4 - MIN_CLIP_SECONDS })
    expect(trimClip(clips[0]!, 'in', -2, 8)).toMatchObject({ in: 0 })
  })

  it('trims the out point within the source and at least half a second after the in point', () => {
    expect(trimClip(clips[1]!, 'out', 9, 10)).toMatchObject({ in: 1, out: 9 })
    expect(trimClip(clips[1]!, 'out', 12, 10)).toMatchObject({ out: 10 })
    expect(trimClip(clips[1]!, 'out', 1.2, 10)).toMatchObject({ out: 1 + MIN_CLIP_SECONDS })
  })

  it('adds up what actually plays', () => {
    expect(totalDuration(clips, sourceOf)).toBe(4 + 5 + 3)
  })

  it('maps the playhead to a clip and a time inside its source', () => {
    expect(startOfClip(clips, sourceOf, 1)).toBe(4)
    expect(locateTime(clips, sourceOf, 0)).toEqual({ index: 0, sourceTime: 0 })
    // 第二段从源片第 1 秒开始播：全局 5 秒处是它播了 1 秒，即源片第 2 秒。
    expect(locateTime(clips, sourceOf, 5)).toEqual({ index: 1, sourceTime: 2 })
    expect(locateTime(clips, sourceOf, 11)).toEqual({ index: 2, sourceTime: 2 })
    expect(locateTime(clips, sourceOf, 99)).toEqual({ index: 2, sourceTime: 3 })
  })
})

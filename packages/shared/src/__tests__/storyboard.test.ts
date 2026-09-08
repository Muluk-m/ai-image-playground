import { describe, expect, it } from 'bun:test'
import {
  parseStoryboardPlan,
  STORYBOARD_SHOT_COUNTS,
  STORYBOARD_TOTAL_SECONDS,
  type StoryboardShot,
  storyboardRangeLabel,
  storyboardSegments,
} from '../storyboard'
import { VIDEO_DURATIONS } from '../video-presets'

const EXPECTED = { shots: 2, totalSeconds: 10 }

function shot(no: number, overrides: Partial<Record<keyof StoryboardShot, unknown>> = {}) {
  return {
    no,
    title: `第 ${no} 镜`,
    description: '主角站在雨后的天台上，逆光',
    camera: '缓慢推进',
    line: '再来一次。',
    imagePrompt: 'a rooftop after rain, backlit, cinematic, 16:9',
    videoPrompt: 'slow push in, rain drips off the railing, light warms up',
    ...overrides,
  }
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    title: '天台重逢',
    summary: '两镜讲完一次久别重逢',
    videoPrompt: '穿米色风衣的女人，雨后天台，冷调胶片\n镜头1（0-5秒）：她推门而出，缓慢推进',
    shots: [shot(1), shot(2)],
    ...overrides,
  }
}

describe('the storyboard presets', () => {
  it('offers shot counts a grid can hold and totals the video models accept', () => {
    expect([...STORYBOARD_SHOT_COUNTS]).toEqual([2, 3, 4, 5])
    for (const seconds of STORYBOARD_TOTAL_SECONDS) {
      expect(VIDEO_DURATIONS).toContain(seconds)
    }
  })
})

describe('storyboardSegments', () => {
  it('splits the total into contiguous ranges that add back up to it', () => {
    for (const totalSeconds of STORYBOARD_TOTAL_SECONDS) {
      for (const shots of STORYBOARD_SHOT_COUNTS) {
        const segments = storyboardSegments(totalSeconds, shots)

        expect(segments).toHaveLength(shots)
        expect(segments[0]!.startSeconds).toBe(0)
        expect(segments.reduce((sum, one) => sum + one.seconds, 0)).toBe(totalSeconds)
        for (const [index, segment] of segments.entries()) {
          expect(segment.seconds * 2).toBe(Math.round(segment.seconds * 2))
          if (index > 0) {
            const previous = segments[index - 1]!
            expect(segment.startSeconds).toBe(previous.startSeconds + previous.seconds)
          }
        }
      }
    }
  })

  it('rounds an uneven split to half seconds', () => {
    expect(storyboardSegments(15, 2)).toEqual([
      { startSeconds: 0, seconds: 7.5 },
      { startSeconds: 7.5, seconds: 7.5 },
    ])
    expect(storyboardSegments(10, 3)).toEqual([
      { startSeconds: 0, seconds: 3.5 },
      { startSeconds: 3.5, seconds: 3 },
      { startSeconds: 6.5, seconds: 3.5 },
    ])
  })
})

describe('storyboardRangeLabel', () => {
  it('writes the range without trailing zeros', () => {
    expect(storyboardRangeLabel({ startSeconds: 0, seconds: 5 })).toBe('0-5')
    expect(storyboardRangeLabel({ startSeconds: 3.5, seconds: 3 })).toBe('3.5-6.5')
  })
})

describe('parseStoryboardPlan', () => {
  it('takes a well formed plan and trims every free-text field', () => {
    const parsed = parseStoryboardPlan(
      plan({ title: '  天台重逢 ', shots: [shot(1, { camera: ' 缓慢推进\n' }), shot(2)] }),
      EXPECTED,
    )

    expect(parsed).not.toBeNull()
    expect(parsed?.title).toBe('天台重逢')
    expect(parsed?.shots[0]?.camera).toBe('缓慢推进')
    expect(parsed?.shots).toHaveLength(2)
  })

  it('lays the requested timeline over whatever the model wrote', () => {
    const parsed = parseStoryboardPlan(
      plan({ shots: [shot(1, { startSeconds: 4, seconds: 9 }), shot(2, { seconds: 3 })] }),
      { shots: 2, totalSeconds: 15 },
    )

    expect(parsed?.shots.map((one) => [one.startSeconds, one.seconds])).toEqual([
      [0, 7.5],
      [7.5, 7.5],
    ])
  })

  it('rejects a shot count other than the one asked for', () => {
    expect(parseStoryboardPlan(plan({ shots: [shot(1)] }), EXPECTED)).toBeNull()
    expect(parseStoryboardPlan(plan({ shots: [shot(1), shot(2), shot(3)] }), EXPECTED)).toBeNull()
  })

  it('rejects shot numbers that are out of order or renumbered', () => {
    expect(parseStoryboardPlan(plan({ shots: [shot(2), shot(1)] }), EXPECTED)).toBeNull()
    expect(parseStoryboardPlan(plan({ shots: [shot(0), shot(1)] }), EXPECTED)).toBeNull()
    expect(
      parseStoryboardPlan(plan({ shots: [shot(1), { ...shot(2), no: '2' }] }), EXPECTED),
    ).toBeNull()
  })

  it('rejects a plan missing a title, a summary or the whole-video prompt', () => {
    expect(parseStoryboardPlan(plan({ title: '  ' }), EXPECTED)).toBeNull()
    expect(parseStoryboardPlan(plan({ summary: undefined }), EXPECTED)).toBeNull()
    expect(parseStoryboardPlan(plan({ videoPrompt: '' }), EXPECTED)).toBeNull()
  })

  it('rejects a shot missing any field the exported storyboard needs', () => {
    for (const field of ['title', 'description', 'camera', 'imagePrompt', 'videoPrompt']) {
      expect(
        parseStoryboardPlan(plan({ shots: [shot(1, { [field]: '' }), shot(2)] }), EXPECTED),
      ).toBeNull()
    }
  })

  it('accepts a shot without a spoken line', () => {
    const parsed = parseStoryboardPlan(
      plan({ shots: [shot(1, { line: '' }), shot(2, { line: undefined })] }),
      EXPECTED,
    )

    expect(parsed?.shots.map((one) => one.line)).toEqual(['', ''])
  })

  it('rejects anything that is not a plan object', () => {
    expect(parseStoryboardPlan(null, EXPECTED)).toBeNull()
    expect(parseStoryboardPlan('分镜', EXPECTED)).toBeNull()
    expect(parseStoryboardPlan(plan({ shots: 'two' }), EXPECTED)).toBeNull()
  })
})

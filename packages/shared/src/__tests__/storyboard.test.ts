import { describe, expect, it } from 'bun:test'
import {
  parseStoryboardPlan,
  STORYBOARD_SECONDS,
  STORYBOARD_SHOT_COUNTS,
  type StoryboardShot,
} from '../storyboard'
import { VIDEO_DURATIONS } from '../video-presets'

const EXPECTED = { shots: 2, seconds: 5 }

function shot(no: number, overrides: Partial<Record<keyof StoryboardShot, unknown>> = {}) {
  return {
    no,
    title: `第 ${no} 镜`,
    description: '主角站在雨后的天台上，逆光',
    camera: '缓慢推进',
    line: '再来一次。',
    seconds: 5,
    imagePrompt: 'a rooftop after rain, backlit, cinematic, 16:9',
    videoPrompt: 'slow push in, rain drips off the railing, light warms up',
    ...overrides,
  }
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    title: '天台重逢',
    summary: '两镜讲完一次久别重逢',
    shots: [shot(1), shot(2)],
    ...overrides,
  }
}

describe('the storyboard presets', () => {
  it('offers shot counts a grid can hold and seconds the video models accept', () => {
    expect([...STORYBOARD_SHOT_COUNTS]).toEqual([2, 3, 4, 6])
    for (const seconds of STORYBOARD_SECONDS) {
      expect(VIDEO_DURATIONS).toContain(seconds)
    }
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

  it('forces the requested seconds onto every shot', () => {
    const parsed = parseStoryboardPlan(
      plan({ shots: [shot(1, { seconds: 10 }), shot(2, { seconds: 3 })] }),
      { shots: 2, seconds: 8 },
    )

    expect(parsed?.shots.map((one) => one.seconds)).toEqual([8, 8])
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

  it('rejects a plan missing a title or a summary', () => {
    expect(parseStoryboardPlan(plan({ title: '  ' }), EXPECTED)).toBeNull()
    expect(parseStoryboardPlan(plan({ summary: undefined }), EXPECTED)).toBeNull()
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

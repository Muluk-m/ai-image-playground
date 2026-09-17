import { describe, expect, it } from 'bun:test'
import {
  parseFrameRate,
  parseStitchProbe,
  STITCH_LIMITS,
  type StitchProbe,
  stitchAdaptations,
  stitchFfmpegArgs,
  stitchFilterGraph,
  stitchLimitRefusal,
  stitchTarget,
} from '../../../lib/agent/video-stitch-plan'

// 纯算式，不起进程也不连库：这里测的正是「不同模型出的片参数不一样时，命令行该长什么样」。

function probe(overrides: Partial<StitchProbe> = {}): StitchProbe {
  return { width: 1280, height: 720, durationSeconds: 5, fps: 30, hasAudio: false, ...overrides }
}

const PROBE_JSON = JSON.stringify({
  streams: [
    { codec_type: 'video', width: 1920, height: 1080, duration: '8.2', r_frame_rate: '30000/1001' },
    { codec_type: 'audio' },
  ],
  format: { duration: '8.24' },
})

describe('parseStitchProbe', () => {
  it('reads the five things the concat plan needs', () => {
    expect(parseStitchProbe(PROBE_JSON)).toEqual({
      width: 1920,
      height: 1080,
      durationSeconds: 8.2,
      fps: 30000 / 1001,
      hasAudio: true,
    })
  })

  it('falls back to the container duration when the stream has none', () => {
    const json = JSON.stringify({
      streams: [{ codec_type: 'video', width: 720, height: 1280, r_frame_rate: '24/1' }],
      format: { duration: '6' },
    })
    expect(parseStitchProbe(json)).toMatchObject({ durationSeconds: 6, hasAudio: false })
  })

  it('assumes a frame rate when ffprobe reports none, instead of dropping the segment', () => {
    const json = JSON.stringify({
      streams: [{ codec_type: 'video', width: 640, height: 360, duration: '3' }],
    })
    expect(parseStitchProbe(json)?.fps).toBe(24)
  })

  it.each([
    ['not json at all', 'definitely not json'],
    ['a payload with no video stream', JSON.stringify({ streams: [{ codec_type: 'audio' }] })],
    [
      'a video stream with no duration anywhere',
      JSON.stringify({ streams: [{ codec_type: 'video', width: 10, height: 10 }] }),
    ],
  ])('refuses %s', (_label, stdout) => {
    expect(parseStitchProbe(stdout)).toBeNull()
  })
})

describe('parseFrameRate', () => {
  it.each([
    ['30000/1001', 30000 / 1001],
    ['25', 25],
  ])('reads %s', (value, expected) => {
    expect(parseFrameRate(value)).toBeCloseTo(expected, 6)
  })

  it.each(['0/0', '', 'abc', undefined])('rejects %s', (value) => {
    expect(parseFrameRate(value)).toBeNull()
  })
})

describe('stitchTarget', () => {
  it('takes the first segment resolution, so the film keeps the frame the user already saw', () => {
    const target = stitchTarget([probe(), probe({ width: 1920, height: 1080 })])
    expect(target).toMatchObject({ width: 1280, height: 720, fps: 30 })
  })

  it('rounds an odd resolution down to even, because libx264 refuses odd frames', () => {
    expect(stitchTarget([probe({ width: 1281, height: 721 })])).toMatchObject({
      width: 1280,
      height: 720,
    })
  })

  it('leaves the film silent when no segment carries audio', () => {
    const target = stitchTarget([probe(), probe()])
    expect(target.withAudio).toBe(false)
    expect(target.silentInputIndex).toBeUndefined()
  })

  it('adds a silent source only when audio has to be filled in', () => {
    const bothLoud = stitchTarget([probe({ hasAudio: true }), probe({ hasAudio: true })])
    expect(bothLoud.withAudio).toBe(true)
    expect(bothLoud.silentInputIndex).toBeUndefined()
    expect(stitchTarget([probe({ hasAudio: true }), probe()])).toMatchObject({
      withAudio: true,
      // 静音那路排在真输入后面，下标必须等于段数。
      silentInputIndex: 2,
    })
  })
})

describe('stitchAdaptations', () => {
  it('separates a plain resize from a letterbox, and names the silenced segment', () => {
    const probes = [
      probe({ hasAudio: true }),
      // 同画幅、更大分辨率：只缩放。
      probe({ width: 1920, height: 1080, hasAudio: true }),
      // 竖屏接进横屏：补边。
      probe({ width: 720, height: 1280 }),
    ]
    expect(stitchAdaptations(probes, stitchTarget(probes))).toEqual([
      { index: 0, scaled: false, padded: false, silenced: false },
      { index: 1, scaled: true, padded: false, silenced: false },
      { index: 2, scaled: true, padded: true, silenced: true },
    ])
  })
})

describe('stitchFfmpegArgs', () => {
  const paths = ['/tmp/in-0.mp4', '/tmp/in-1.mp4']

  it('never copies streams: mixed encodings make -c copy a silent corruption', () => {
    const probes = [probe(), probe({ width: 1920, height: 1080, fps: 24 })]
    const args = stitchFfmpegArgs({
      inputPaths: paths,
      probes,
      target: stitchTarget(probes),
      outputPath: '/tmp/out.mp4',
    })
    expect(args).not.toContain('copy')
    expect(args.join(' ')).toContain('-c:v libx264')
    expect(args.at(-1)).toBe('/tmp/out.mp4')
  })

  it('feeds the inputs in play order, because order is the one thing the model decides', () => {
    const probes = [probe(), probe()]
    const args = stitchFfmpegArgs({
      inputPaths: paths,
      probes,
      target: stitchTarget(probes),
      outputPath: '/tmp/out.mp4',
    })
    const inputs = args.flatMap((arg, at) => (arg === '-i' ? [args[at + 1]] : []))
    expect(inputs).toEqual(paths)
  })

  it('keeps the silent source and the audio map out of an all-silent film', () => {
    const probes = [probe(), probe()]
    const args = stitchFfmpegArgs({
      inputPaths: paths,
      probes,
      target: stitchTarget(probes),
      outputPath: '/tmp/out.mp4',
    })
    expect(args.join(' ')).not.toContain('anullsrc')
    expect(args).not.toContain('[outa]')
    expect(args.join(' ')).toContain('concat=n=2:v=1:a=0')
  })

  it('fills a missing track with silence exactly as long as that segment', () => {
    const probes = [probe({ hasAudio: true }), probe({ durationSeconds: 7.5 })]
    const target = stitchTarget(probes)
    const args = stitchFfmpegArgs({
      inputPaths: paths,
      probes,
      target,
      outputPath: '/tmp/out.mp4',
    })
    const line = args.join(' ')
    expect(line).toContain('-f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000')
    expect(line).toContain('[2:a]atrim=0:7.500')
    expect(line).toContain('concat=n=2:v=1:a=1')
    expect(args).toContain('[outa]')
  })
})

describe('stitchFilterGraph', () => {
  it('scales inside the frame and pads the rest, instead of stretching the picture', () => {
    const probes = [probe(), probe({ width: 720, height: 1280 })]
    const graph = stitchFilterGraph(probes, stitchTarget(probes))
    expect(graph).toContain('[1:v]scale=1280:720:force_original_aspect_ratio=decrease')
    expect(graph).toContain('pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black')
    expect(graph).toContain('setsar=1,fps=30')
  })
})

describe('stitchLimitRefusal', () => {
  it('says nothing when the request fits', () => {
    expect(stitchLimitRefusal([probe(), probe()])).toBeNull()
  })

  it('refuses a single segment: there is nothing to stitch', () => {
    expect(stitchLimitRefusal([probe()])).toContain(`${STITCH_LIMITS.minSegments}`)
  })

  it('refuses more segments than this machine will chew through', () => {
    const many = Array.from({ length: STITCH_LIMITS.maxSegments + 1 }, () => probe())
    expect(stitchLimitRefusal(many)).toContain(`${STITCH_LIMITS.maxSegments}`)
  })

  it('refuses a film longer than the per-call budget', () => {
    const long = [probe({ durationSeconds: 100 }), probe({ durationSeconds: 100 })]
    expect(stitchLimitRefusal(long)).toContain(`${STITCH_LIMITS.maxTotalSeconds}`)
  })
})

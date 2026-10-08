import { describe, expect, it } from 'bun:test'
import { isVideoGenerationRecord, videoGenerationSource } from '../video-generation'

const BASE = { model: 'grok-imagine-video', duration: 6, aspectRatio: '9:16', resolution: '720p' }

describe('视频生成记录', () => {
  it('accepts a text-to-video record', () => {
    expect(isVideoGenerationRecord(BASE)).toBe(true)
    expect(videoGenerationSource(BASE as never)).toBe('text')
  })

  it('tells image-to-video and derived records apart', () => {
    expect(videoGenerationSource({ ...BASE, firstFrameId: 'el_a' } as never)).toBe('image')
    expect(
      videoGenerationSource({
        ...BASE,
        firstFrameId: 'el_a',
        derivedFrom: { id: 'el_b', mode: 'extend' },
      } as never),
    ).toBe('derived')
  })

  it('accepts an extension length that is off the preset ladder', () => {
    // 续写的秒数不走档位表；拒掉它，续写出来的片子就再也记不下来。
    expect(isVideoGenerationRecord({ ...BASE, duration: 2 })).toBe(true)
  })

  it('keeps the reference images a video was generated from, in order', () => {
    const record = { ...BASE, referenceIds: ['el_a', 'el_b'] }
    expect(isVideoGenerationRecord(record)).toBe(true)
    expect(videoGenerationSource(record as never)).toBe('image')
    expect(isVideoGenerationRecord({ ...BASE, firstFrameId: 'el_a', referenceIds: ['el_b'] })).toBe(
      true,
    )
  })

  it('rejects a malformed reference list', () => {
    expect(isVideoGenerationRecord({ ...BASE, referenceIds: 'el_a' })).toBe(false)
    expect(isVideoGenerationRecord({ ...BASE, referenceIds: [''] })).toBe(false)
    expect(isVideoGenerationRecord({ ...BASE, referenceIds: [1] })).toBe(false)
    expect(isVideoGenerationRecord({ ...BASE, referenceIds: ['el_a', 'el_a'] })).toBe(false)
    expect(isVideoGenerationRecord({ ...BASE, firstFrameId: 'el_a', referenceIds: ['el_a'] })).toBe(
      false,
    )
    expect(
      isVideoGenerationRecord({
        ...BASE,
        referenceIds: Array.from({ length: 17 }, (_, i) => `el_${i}`),
      }),
    ).toBe(false)
  })

  it('keeps preset voices on a text record and keyframes on an image record', () => {
    expect(isVideoGenerationRecord({ ...BASE, voices: ['Eve'] })).toBe(true)
    expect(videoGenerationSource({ ...BASE, voices: ['eve'] } as never)).toBe('text')
    const keyed = {
      ...BASE,
      keyframes: [{ imageId: 'el_mid', timestampSeconds: 2 }],
      voices: ['eve', 'leo'],
    }
    expect(isVideoGenerationRecord(keyed)).toBe(true)
    expect(videoGenerationSource(keyed as never)).toBe('image')
  })

  it('rejects a keyframe or voice that could not have been submitted', () => {
    expect(
      isVideoGenerationRecord({
        ...BASE,
        keyframes: [{ imageId: 'el_mid', timestampSeconds: 0 }],
      }),
    ).toBe(false)
    expect(
      isVideoGenerationRecord({
        ...BASE,
        keyframes: [{ imageId: 'el_mid', timestampSeconds: 1.2 }],
      }),
    ).toBe(false)
    expect(
      isVideoGenerationRecord({
        ...BASE,
        firstFrameId: 'el_a',
        keyframes: [{ imageId: 'el_a', timestampSeconds: 2 }],
      }),
    ).toBe(false)
    expect(isVideoGenerationRecord({ ...BASE, voices: ['morgan'] })).toBe(false)
    expect(isVideoGenerationRecord({ ...BASE, voices: ['eve', 'eve'] })).toBe(false)
  })

  it('rejects records a newer or broken client could have written', () => {
    expect(isVideoGenerationRecord(null)).toBe(false)
    expect(isVideoGenerationRecord({ ...BASE, model: '' })).toBe(false)
    expect(isVideoGenerationRecord({ ...BASE, duration: 0 })).toBe(false)
    expect(isVideoGenerationRecord({ ...BASE, duration: Number.NaN })).toBe(false)
    expect(isVideoGenerationRecord({ ...BASE, aspectRatio: '4:3' })).toBe(false)
    expect(isVideoGenerationRecord({ ...BASE, resolution: '4k' })).toBe(false)
    expect(isVideoGenerationRecord({ ...BASE, firstFrameId: 3 })).toBe(false)
    expect(isVideoGenerationRecord({ ...BASE, derivedFrom: { id: 'x', mode: 'generate' } })).toBe(
      false,
    )
    expect(isVideoGenerationRecord({ ...BASE, extra: true })).toBe(false)
  })
})

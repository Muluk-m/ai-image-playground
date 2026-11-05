import { describe, expect, it } from 'bun:test'
import { isGptDirectModel } from '../gpt-direct'
import {
  gifSpriteExceedsLimit,
  gptImage26Credits,
  gptImage26RateMultiplier,
  gptImage26Rejection,
  isGptImage26Model,
} from '../gpt-image-26'

const FLARE = 'gpt-image-2.6-flare'

describe('gpt image 2.6 identity', () => {
  it('is not a 2.5 direct model, so it cannot fall back to sub2api', () => {
    expect(isGptImage26Model(FLARE)).toBe(true)
    expect(isGptImage26Model('gpt-image-2.6-sunburst')).toBe(true)
    expect(isGptImage26Model('gpt-image-2.5-flare')).toBe(false)
    expect(isGptDirectModel(FLARE)).toBe(false)
  })
})

describe('gif sprite limit', () => {
  it('rejects the measured 1024×6 failure and accepts the measured 768×6 success', () => {
    expect(gifSpriteExceedsLimit(1024, 1024, 6)).toBe(true)
    expect(gifSpriteExceedsLimit(768, 768, 6)).toBe(false)
  })

  it('accepts the product sizes through 16 frames', () => {
    for (const edge of [512, 768]) {
      for (const frames of [4, 6, 9, 12, 16]) {
        expect(gifSpriteExceedsLimit(edge, edge, frames)).toBe(false)
      }
    }
  })
})

describe('gpt image 2.6 credits', () => {
  it('prices stills from the published table, with 4K equal to 2K', () => {
    expect(gptImage26Credits({ size: '1024x1024', quality: 'low' })).toBe(190)
    expect(gptImage26Credits({ size: '1024x1024', quality: 'medium' })).toBe(330)
    expect(gptImage26Credits({ size: '1024x1024', quality: 'auto' })).toBe(330)
    expect(gptImage26Credits({ size: '1024x1024', quality: 'high' })).toBe(400)
    expect(gptImage26Credits({ size: '2048x2048', quality: 'low' })).toBe(380)
    expect(gptImage26Credits({ size: '2048x2048', quality: 'medium' })).toBe(670)
    expect(gptImage26Credits({ size: '2048x2048', quality: 'high' })).toBe(810)
    expect(gptImage26Credits({ size: '3840x2160', quality: 'low' })).toBe(380)
    expect(gptImage26Credits({ size: '3840x2160', quality: 'medium' })).toBe(670)
    expect(gptImage26Credits({ size: '3840x2160', quality: 'high' })).toBe(810)
  })

  it('prices an edit as the same-tier still times 390/330, plus 60 per extra reference', () => {
    expect(
      gptImage26Credits({
        size: '1024x1024',
        quality: 'medium',
        input_images: ['a'],
      }),
    ).toBe(390)
    expect(
      gptImage26Credits({
        size: '1024x1024',
        quality: 'medium',
        input_images: ['a', 'b', 'c'],
      }),
    ).toBe(390 + 120)
    expect(gptImage26Credits({ size: '1024x1024', quality: 'low', input_images: ['a'] })).toBe(220)
    expect(gptImage26Credits({ size: '1024x1024', quality: 'high', input_images: ['a'] })).toBe(470)
    expect(gptImage26Credits({ size: '2048x2048', quality: 'medium', input_images: ['a'] })).toBe(
      790,
    )
    expect(gptImage26Credits({ size: '3840x2160', quality: 'high', input_images: ['a'] })).toBe(960)
    // 带遮罩的尺寸跟着原图走，档位按 1K。
    expect(
      gptImage26Credits({
        size: '2048x2048',
        quality: 'medium',
        mask: 'm',
        input_images: ['a'],
      }),
    ).toBe(390)
  })

  it('prices gif bands and svg as flat amounts, same for both models', () => {
    expect(gptImage26Credits({ output_format: 'gif', frame_count: 4 })).toBe(370)
    expect(gptImage26Credits({ output_format: 'gif', frame_count: 6 })).toBe(370)
    expect(gptImage26Credits({ output_format: 'gif', frame_count: 9 })).toBe(550)
    expect(gptImage26Credits({ output_format: 'gif', frame_count: 12 })).toBe(980)
    expect(gptImage26Credits({ output_format: 'gif', frame_count: 16 })).toBe(980)
    expect(gptImage26Credits({ output_format: 'svg' })).toBe(610)
  })

  it('turns the credit into a multiplier of the 100-credit base without rounding drift', () => {
    const samples = [
      { size: '1024x1024', quality: 'low' },
      { size: '1024x1024', quality: 'medium' },
      { size: '2048x2048', quality: 'high' },
      { size: '3840x2160', quality: 'medium' },
      { output_format: 'gif', frame_count: 9 },
      { output_format: 'svg' },
      { size: '1024x1024', quality: 'medium', input_images: ['a', 'b'] },
    ]
    for (const sample of samples) {
      const credits = gptImage26Credits(sample)
      expect(Math.round(100 * gptImage26RateMultiplier(sample))).toBe(credits)
    }
  })
})

describe('gpt image 2.6 rejection', () => {
  const gif = { output_format: 'gif', size: '768x768', frame_count: 6, frame_duration_ms: 200 }

  it('rejects before billing when direct is off, the sprite is too big, or the format is an edit', () => {
    expect(gptImage26Rejection(FLARE, { size: '1024x1024' }, false)).toBe('unavailable')
    expect(gptImage26Rejection(FLARE, gif, true)).toBe(null)
    expect(gptImage26Rejection(FLARE, { ...gif, size: '1024x1024' }, true)).toBe('gif_sprite')
    expect(gptImage26Rejection(FLARE, { ...gif, frame_count: 64 }, true)).toBe('gif_frames')
    expect(gptImage26Rejection(FLARE, { ...gif, n: 2 }, true)).toBe('gif_count')
    expect(gptImage26Rejection(FLARE, { ...gif, input_images: ['a'] }, true)).toBe('gif_edit')
    expect(gptImage26Rejection(FLARE, { output_format: 'svg', input_images: ['a'] }, true)).toBe(
      'svg_edit',
    )
    expect(gptImage26Rejection(FLARE, { output_format: 'svg', n: 2 }, true)).toBe('svg_count')
    expect(gptImage26Rejection('gpt-image-2.5-flare', gif, false)).toBe(null)
  })
})

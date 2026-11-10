import { describe, expect, it } from 'bun:test'
import { imageRateMultiplier, isGptDirectModel } from '../gpt-direct'
import {
  degradeGptImage26ForSub2api,
  gifSpriteExceedsLimit,
  gptImage26Credits,
  gptImage26RateMultiplier,
  gptImage26Rejection,
  isGptImage26Model,
  withGptImage26GifDefaults,
} from '../gpt-image-26'
import { IMAGE_SIZE_PRESETS } from '../image'

const FLARE = 'gpt-image-2.6-flare'

describe('gpt image 2.6 identity', () => {
  it('is not a 2.5 direct model, so a sub2api fallback does not use that settlement table', () => {
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

  it('accepts 768×12 and 512×16, but rejects a fourth 768px sprite row', () => {
    expect(gifSpriteExceedsLimit(768, 768, 12)).toBe(false)
    expect(gifSpriteExceedsLimit(512, 512, 16)).toBe(false)
    for (const frames of [13, 14, 15, 16]) {
      expect(gifSpriteExceedsLimit(768, 768, frames)).toBe(true)
    }
  })

  it('counts empty sprite cells and both frame dimensions in the pixel budget', () => {
    expect(gifSpriteExceedsLimit(736, 736, 13)).toBe(true)
    expect(gifSpriteExceedsLimit(768, 512, 16)).toBe(false)
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

  it('goes through imageRateMultiplier, which otherwise treats unknown models as one', () => {
    expect(imageRateMultiplier(FLARE, { size: '1024x1024', quality: 'medium' })).toBe(3.3)
    expect(imageRateMultiplier(FLARE, { output_format: 'svg' })).toBe(6.1)
    expect(imageRateMultiplier(FLARE, { output_format: 'gif', frame_count: 9 })).toBe(5.5)
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

  it('lets a still through when direct is off, and still rejects gif, svg, and bad sprites', () => {
    expect(
      gptImage26Rejection(
        FLARE,
        { size: '1024x1024', quality: 'low', output_format: 'png' },
        false,
      ),
    ).toBe(null)
    expect(gptImage26Rejection(FLARE, gif, false)).toBe('unavailable')
    expect(gptImage26Rejection(FLARE, { output_format: 'svg' }, false)).toBe('unavailable')
    expect(gptImage26Rejection(FLARE, gif, true)).toBe(null)
    expect(gptImage26Rejection(FLARE, { ...gif, size: '1024x1024' }, true)).toBe('gif_sprite')
    expect(gptImage26Rejection(FLARE, { ...gif, frame_count: 16 }, true)).toBe('gif_sprite')
    expect(gptImage26Rejection(FLARE, { ...gif, frame_count: 12 }, true)).toBe(null)
    expect(gptImage26Rejection(FLARE, { ...gif, frame_count: 64 }, true)).toBe('gif_frames')
    expect(gptImage26Rejection(FLARE, { ...gif, n: 2 }, true)).toBe('gif_count')
    expect(gptImage26Rejection(FLARE, { ...gif, input_images: ['a'] }, true)).toBe('gif_edit')
    expect(gptImage26Rejection(FLARE, { output_format: 'svg', input_images: ['a'] }, true)).toBe(
      'svg_edit',
    )
    expect(gptImage26Rejection(FLARE, { output_format: 'svg', n: 2 }, true)).toBe('svg_count')
    expect(gptImage26Rejection('gpt-image-2.5-flare', gif, false)).toBe(null)
  })

  it('fills the frame defaults the settings control already shows, and leaves an explicit 16-frame request alone', () => {
    expect(
      withGptImage26GifDefaults({ output_format: 'gif', size: '768x768', quality: 'medium' }),
    ).toEqual({
      output_format: 'gif',
      size: '768x768',
      quality: 'medium',
      frame_count: 6,
      frame_duration_ms: 200,
    })
    const explicit = {
      output_format: 'gif' as const,
      size: '768x768',
      frame_count: 16,
      frame_duration_ms: 300,
    }
    expect(withGptImage26GifDefaults(explicit)).toBe(explicit)
    expect(gptImage26Rejection(FLARE, withGptImage26GifDefaults(explicit), true)).toBe('gif_sprite')
    expect(
      gptImage26Rejection(
        FLARE,
        withGptImage26GifDefaults({ output_format: 'gif', size: '768x768' }),
        true,
      ),
    ).toBe(null)
  })

  it('accepts every still-image preset at low, medium, and high quality', () => {
    for (const tier of ['1K', '2K', '4K'] as const) {
      for (const size of Object.values(IMAGE_SIZE_PRESETS[tier])) {
        for (const quality of ['low', 'medium', 'high'] as const) {
          expect(
            gptImage26Rejection(FLARE, { size, quality, output_format: 'png', n: 4 }, true),
          ).toBe(null)
        }
      }
    }
  })
})

describe('degradeGptImage26ForSub2api', () => {
  it('收成 1K medium 静态图，并按收口后的积分计价', () => {
    const degraded = degradeGptImage26ForSub2api({
      output_format: 'gif',
      size: '2048x2048',
      quality: 'high',
      frame_count: 12,
      frame_duration_ms: 100,
    })
    expect(degraded?.kind).toBe('size_quality_format')
    expect(degraded?.request).toMatchObject({
      output_format: 'png',
      size: '1024x1024',
      quality: 'medium',
    })
    expect(degraded?.request.frame_count).toBeUndefined()
    expect(degraded?.request.frame_duration_ms).toBeUndefined()
    expect(gptImage26RateMultiplier(degraded!.request)).toBe(3.3)
    expect(
      gptImage26RateMultiplier({
        size: '2048x2048',
        quality: 'high',
        output_format: 'gif',
        frame_count: 12,
      }),
    ).toBe(9.8)
  })

  it('已经是 1K 非高画质静态图时不改', () => {
    expect(
      degradeGptImage26ForSub2api({ size: '1024x1024', quality: 'low', output_format: 'png' }),
    ).toBeNull()
  })

  it('动图没写尺寸时收成 1K，并记在降级字段里', () => {
    const degraded = degradeGptImage26ForSub2api({ output_format: 'svg', quality: 'low' })
    const request = degraded?.request as { size?: string; output_format?: string }
    expect(request?.output_format).toBe('png')
    expect(request?.size).toBe('1024x1024')
    expect(degraded?.fields).toContainEqual({ field: 'size', to: '1024x1024' })
  })
})

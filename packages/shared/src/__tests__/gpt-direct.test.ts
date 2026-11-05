import { describe, expect, it } from 'bun:test'
import {
  clampGptBasicRequest,
  clampGptNonMemberRequest,
  gptCeilingRateMultiplier,
  gptImageRateMultiplier,
  isGptBasicRequest,
  isGptDirectModel,
  isGptNonMemberRequest,
  isGptSub2apiDeliverable,
} from '../gpt-direct'
import { IMAGE_SIZE_PRESETS, imageSizeTier, imageTierMaxPixels, parseImageSize } from '../image'

const FLARE = 'gpt-image-2.5-flare'

describe('gpt direct models', () => {
  it('covers flare and sunburst only', () => {
    expect(isGptDirectModel(FLARE)).toBe(true)
    expect(isGptDirectModel('gpt-image-2.5-sunburst')).toBe(true)
    expect(isGptDirectModel('gpt-image-2')).toBe(false)
  })

  it('treats 1K below high quality as the sub2api tier, and up to 2K as the non-member tier', () => {
    expect(isGptSub2apiDeliverable({ size: '1024x1024', quality: 'medium' })).toBe(true)
    expect(isGptSub2apiDeliverable({})).toBe(true)
    expect(isGptSub2apiDeliverable({ size: '1024x1024', quality: 'high' })).toBe(false)
    expect(isGptSub2apiDeliverable({ size: '2048x2048' })).toBe(false)
    expect(isGptBasicRequest({ size: '1024x1024' })).toBe(true)

    expect(isGptNonMemberRequest({ size: '1024x1024', quality: 'medium' })).toBe(true)
    expect(isGptNonMemberRequest({ size: '2048x2048', quality: 'low' })).toBe(true)
    expect(isGptNonMemberRequest({ size: '2560x1440' })).toBe(true)
    expect(isGptNonMemberRequest({ size: '2048x2048', quality: 'high' })).toBe(false)
    expect(isGptNonMemberRequest({ size: '3840x2160', quality: 'medium' })).toBe(false)
  })
})

describe('gptImageRateMultiplier', () => {
  it('prices by tier and quality, with 1K medium as one', () => {
    expect(gptImageRateMultiplier(FLARE, { size: '1024x1024', quality: 'medium' })).toBe(1)
    expect(gptImageRateMultiplier(FLARE, { size: '1024x1024', quality: 'low' })).toBe(1)
    expect(gptImageRateMultiplier(FLARE, { size: undefined, quality: 'auto' })).toBe(1)
    expect(gptImageRateMultiplier(FLARE, { size: '1024x1024', quality: 'high' })).toBe(4)
    expect(gptImageRateMultiplier(FLARE, { size: '2048x2048', quality: 'medium' })).toBe(2)
    expect(gptImageRateMultiplier(FLARE, { size: '3840x2160', quality: 'high' })).toBe(8)
  })

  it('prices a masked edit by quality alone, since its size follows the source image', () => {
    expect(gptImageRateMultiplier(FLARE, { size: '1920x1088', quality: 'medium', mask: 'm' })).toBe(
      1,
    )
    expect(gptImageRateMultiplier(FLARE, { size: '1920x1088', quality: 'high', mask: 'm' })).toBe(4)
    expect(isGptSub2apiDeliverable({ size: '1920x1088', mask: 'm' })).toBe(true)
    expect(isGptNonMemberRequest({ size: '1920x1088', quality: 'high', mask: 'm' })).toBe(false)
    // 尺寸不动（要和遮罩对齐），只把高画质收回 medium。
    expect(
      clampGptNonMemberRequest(FLARE, { size: '1920x1088', quality: 'high', mask: 'm' }),
    ).toEqual({
      size: '1920x1088',
      quality: 'medium',
      mask: 'm',
    })
  })

  it('prices the ceiling the agent and stage paths actually run', () => {
    expect(gptCeilingRateMultiplier(FLARE, { size: '2560x1440', quality: 'medium' })).toBe(2)
    expect(gptCeilingRateMultiplier(FLARE, { size: '3840x2160', quality: 'high' })).toBe(2)
    expect(gptCeilingRateMultiplier(FLARE, { size: '1024x1024', quality: 'low' })).toBe(1)
    expect(gptCeilingRateMultiplier('gemini-3-pro-image', { size: '3840x2160' })).toBe(1)
  })

  it('leaves every other model at one', () => {
    expect(
      gptImageRateMultiplier('gemini-3-pro-image', { size: '3840x2160', quality: 'high' }),
    ).toBe(1)
  })
})

describe('clampGptNonMemberRequest', () => {
  const maxPixels = imageTierMaxPixels('2K')

  it('scales every 4K preset into 2K, drops high to medium, and stays inside OpenAI limits', () => {
    for (const size of Object.values(IMAGE_SIZE_PRESETS['4K'])) {
      const clamped = clampGptNonMemberRequest(FLARE, { size, quality: 'high', n: 2 })
      const parsed = parseImageSize(clamped.size ?? '')
      expect(parsed).not.toBeNull()
      const pixels = parsed!.width * parsed!.height
      expect(imageSizeTier(clamped.size)).toBe('2K')
      expect(pixels).toBeLessThanOrEqual(maxPixels)
      expect(pixels).toBeGreaterThanOrEqual(655_360)
      expect(parsed!.width % 16).toBe(0)
      expect(parsed!.height % 16).toBe(0)
      expect(parsed!.width).toBeLessThanOrEqual(3840)
      expect(parsed!.height).toBeLessThanOrEqual(3840)
      expect(clamped.quality).toBe('medium')
      expect(isGptNonMemberRequest(clamped)).toBe(true)
      const source = parseImageSize(size)!
      const sourceRatio = source.width / source.height
      const nextRatio = parsed!.width / parsed!.height
      expect(Math.abs(sourceRatio - nextRatio) / sourceRatio).toBeLessThan(0.04)
    }
    expect(clampGptNonMemberRequest(FLARE, { size: '3840x2160', quality: 'high', n: 2 })).toEqual({
      size: '2720x1536',
      quality: 'medium',
      n: 2,
    })
    expect(clampGptNonMemberRequest(FLARE, { size: '2880x2880', quality: 'medium' })).toEqual({
      size: '2048x2048',
      quality: 'medium',
    })
    expect(clampGptNonMemberRequest(FLARE, { size: '2160x3840', quality: 'low' }).size).toBe(
      '1536x2720',
    )
  })

  it('is stable: clamping twice gives the same request (submission hashes must match)', () => {
    const once = clampGptNonMemberRequest(FLARE, { size: '2160x3840', quality: 'high' })
    expect(clampGptNonMemberRequest(FLARE, once)).toBe(once)
    expect(clampGptBasicRequest(FLARE, once)).toBe(once)
  })

  it('returns the same object when nothing needs to change', () => {
    const request = { size: '2048x2048', quality: 'medium' }
    expect(clampGptNonMemberRequest(FLARE, request)).toBe(request)
    const basic = { size: '1024x1024', quality: 'low' }
    expect(clampGptNonMemberRequest(FLARE, basic)).toBe(basic)
    const other = { size: '3840x2160', quality: 'high' }
    expect(clampGptNonMemberRequest('gemini-3-pro-image', other)).toBe(other)
  })

  it('only rewrites high quality when the pixels are already within 2K', () => {
    expect(clampGptNonMemberRequest(FLARE, { size: '2560x1440', quality: 'high' })).toEqual({
      size: '2560x1440',
      quality: 'medium',
    })
  })
})

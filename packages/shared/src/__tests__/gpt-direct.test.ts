import { describe, expect, it } from 'bun:test'
import {
  clampGptBasicRequest,
  clampGptNonMemberRequest,
  gptCeilingRateMultiplier,
  gptImageRateMultiplier,
  imageRateMultiplier,
  isGptBasicRequest,
  isGptDirectModel,
  isGptNonMemberRequest,
  isGptSub2apiDeliverable,
  preparedImageRateMultiplier,
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

describe('imageRateMultiplier', () => {
  const NANO = 'gemini-nano-banana-2.1'
  const PRO = 'gemini-3-pro-image'

  it('treats a missing request as no tier instead of throwing', () => {
    expect(imageRateMultiplier(NANO, undefined)).toBe(1)
    expect(imageRateMultiplier(NANO, null, ['1K', '2K'])).toBe(1)
    expect(imageRateMultiplier('gpt-image-2.5-flare', undefined)).toBe(1)
    expect(preparedImageRateMultiplier('gpt-image-2.5-flare', undefined)).toBe(1)
  })

  it('keeps the GPT table, with auto and a missing size priced as 1K medium', () => {
    expect(imageRateMultiplier(FLARE, { size: '1024x1024', quality: 'low' })).toBe(1)
    expect(imageRateMultiplier(FLARE, { size: '1024x1024', quality: 'medium' })).toBe(1)
    expect(imageRateMultiplier(FLARE, { size: '1024x1024', quality: 'high' })).toBe(4)
    expect(imageRateMultiplier(FLARE, { size: '2048x2048', quality: 'low' })).toBe(1)
    expect(imageRateMultiplier(FLARE, { size: '2048x2048', quality: 'medium' })).toBe(2)
    expect(imageRateMultiplier(FLARE, { size: '2048x2048', quality: 'high' })).toBe(8)
    expect(imageRateMultiplier(FLARE, { size: '3840x2160', quality: 'low' })).toBe(1)
    expect(imageRateMultiplier(FLARE, { size: '3840x2160', quality: 'medium' })).toBe(2)
    expect(imageRateMultiplier(FLARE, { size: '3840x2160', quality: 'high' })).toBe(8)
    expect(imageRateMultiplier(FLARE, { size: 'auto', quality: 'auto' })).toBe(1)
    expect(imageRateMultiplier(FLARE, {})).toBe(1)
    expect(imageRateMultiplier('gpt-image-2.5-sunburst', { size: '2048x2048' })).toBe(2)
  })

  it('prices Nano 2.1 and Pro by the requested tier token', () => {
    // 价目表单价 × 倍率，向上取整后：Nano 100/150/340，Pro 150/150/270。
    for (const field of ['image_size', 'gemini_image_size'] as const) {
      expect(imageRateMultiplier(NANO, { [field]: '1K' })).toBe(1)
      expect(imageRateMultiplier(NANO, { [field]: '2K' })).toBe(1.5)
      expect(imageRateMultiplier(NANO, { [field]: '4K' })).toBe(3.4)
      expect(imageRateMultiplier(PRO, { [field]: '1K' })).toBe(1)
      expect(imageRateMultiplier(PRO, { [field]: '2K' })).toBe(1)
      expect(imageRateMultiplier(PRO, { [field]: '4K' })).toBe(1.8)
    }
    expect(imageRateMultiplier(NANO, { image_size: '2K', gemini_image_size: '4K' })).toBe(1.5)
  })

  it('bills a 4K request at the nearest declared tier until that tier is offered', () => {
    const offered = ['1K', '2K']
    expect(imageRateMultiplier(NANO, { image_size: '4K' }, offered)).toBe(1.5)
    expect(imageRateMultiplier(PRO, { image_size: '4K' }, offered)).toBe(1)
    expect(imageRateMultiplier(NANO, { image_size: '4K' }, ['1K', '2K', '4K'])).toBe(3.4)
    expect(imageRateMultiplier(NANO, { image_size: '2K' }, offered)).toBe(1.5)
  })

  it('prices a retry from the stored request tier, not a larger delivered size', () => {
    // size=auto 曾回 1312x1199。旧任务重试带的是落库请求，不看那张图的像素。
    expect(imageRateMultiplier(NANO, { image_size: '2K', size: '1312x1199' })).toBe(1.5)
    expect(imageRateMultiplier(NANO, { image_size: '1K', size: '4096x4096' })).toBe(1)
    expect(imageRateMultiplier(PRO, { size: '4096x4096', quality: 'high' })).toBe(1)
    expect(imageRateMultiplier(NANO, {})).toBe(1)
    expect(imageRateMultiplier(NANO, { image_size: '512' })).toBe(1)
    expect(imageRateMultiplier(NANO, { image_size: '8K' })).toBe(1)
  })

  it('reads Gemini tier multipliers from the capability catalog', () => {
    expect(imageRateMultiplier(NANO, { image_size: '1K' })).toBe(1)
    expect(imageRateMultiplier(NANO, { image_size: '2K' })).toBe(1.5)
    expect(imageRateMultiplier(NANO, { image_size: '4K' })).toBe(3.4)
    expect(imageRateMultiplier(PRO, { image_size: '1K' })).toBe(1)
    expect(imageRateMultiplier(PRO, { image_size: '2K' })).toBe(1)
    expect(imageRateMultiplier(PRO, { image_size: '4K' })).toBe(1.8)
    expect(imageRateMultiplier('grok-imagine-image-2.0', { image_size: '2K' })).toBe(1)
  })

  it('prices prepared requests at the effective GPT ceiling and Gemini membership tier', () => {
    // 与 clampGptNonMemberRequest 同一收口：4K 高画质收到 2K medium（倍率 2），1K 高画质收到 1K medium。
    expect(preparedImageRateMultiplier(FLARE, { size: '3840x2160', quality: 'high' })).toBe(2)
    expect(preparedImageRateMultiplier(FLARE, { size: '2048x2048', quality: 'medium' })).toBe(2)
    expect(gptCeilingRateMultiplier(FLARE, { size: '3840x2160', quality: 'high' })).toBe(2)
    expect(preparedImageRateMultiplier(FLARE, { size: '1024x1024', quality: 'high' })).toBe(1)
    expect(preparedImageRateMultiplier(NANO, { image_size: '2K' })).toBe(1.5)
    expect(preparedImageRateMultiplier(NANO, { image_size: '4K' })).toBe(1.5)
    expect(preparedImageRateMultiplier(PRO, { gemini_image_size: '4K' })).toBe(1)
    expect(preparedImageRateMultiplier(NANO, { image_size: '4K' }, undefined, true)).toBe(3.4)
    expect(preparedImageRateMultiplier(PRO, { gemini_image_size: '4K' }, undefined, true)).toBe(1.8)
    expect(preparedImageRateMultiplier(NANO, { image_size: '4K' }, ['1K', '2K'], true)).toBe(1.5)
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

import { describe, expect, it } from 'bun:test'
import {
  clampGptBasicRequest,
  gptImageRateMultiplier,
  imageRateMultiplier,
  isGptBasicRequest,
  isGptDirectModel,
  preparedImageRateMultiplier,
} from '../gpt-direct'
import { imageSizeTier } from '../image'

const FLARE = 'gpt-image-2.5-flare'

describe('gpt direct models', () => {
  it('covers flare and sunburst only', () => {
    expect(isGptDirectModel(FLARE)).toBe(true)
    expect(isGptDirectModel('gpt-image-2.5-sunburst')).toBe(true)
    expect(isGptDirectModel('gpt-image-2')).toBe(false)
  })

  it('treats 1K below high quality as the basic tier', () => {
    expect(isGptBasicRequest({ size: '1024x1024', quality: 'medium' })).toBe(true)
    expect(isGptBasicRequest({})).toBe(true)
    expect(isGptBasicRequest({ size: '1024x1024', quality: 'high' })).toBe(false)
    expect(isGptBasicRequest({ size: '2048x2048' })).toBe(false)
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
    expect(isGptBasicRequest({ size: '1920x1088', mask: 'm' })).toBe(true)
    // 尺寸不动（要和遮罩对齐），只把高画质收回 medium。
    expect(clampGptBasicRequest(FLARE, { size: '1920x1088', quality: 'high', mask: 'm' })).toEqual({
      size: '1920x1088',
      quality: 'medium',
      mask: 'm',
    })
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

  it('leaves models without an enabled tier table at one, including Grok', () => {
    expect(imageRateMultiplier('grok-imagine-image-2.0', { image_size: '2K' })).toBe(1)
    expect(imageRateMultiplier('gemini-3.1-flash-lite-image', { image_size: '1K' })).toBe(1)
    expect(imageRateMultiplier('workbench-image', { image_size: '4K' })).toBe(1)
  })

  it('prices prepared GPT submissions at the basic tier and leaves Gemini on the request', () => {
    expect(preparedImageRateMultiplier(FLARE, { size: '3840x2160', quality: 'high' })).toBe(1)
    expect(preparedImageRateMultiplier(FLARE, { size: '1024x1024', quality: 'high' })).toBe(1)
    expect(preparedImageRateMultiplier(NANO, { image_size: '2K' })).toBe(1.5)
    expect(preparedImageRateMultiplier(NANO, { image_size: '4K' })).toBe(3.4)
    expect(preparedImageRateMultiplier(PRO, { gemini_image_size: '4K' })).toBe(1.8)
    const once = preparedImageRateMultiplier(NANO, { image_size: '2K' })
    expect(preparedImageRateMultiplier(NANO, { image_size: '2K' })).toBe(once)
  })
})

describe('clampGptBasicRequest', () => {
  it('scales an oversize request into 1K keeping the ratio, on multiples of 16', () => {
    const clamped = clampGptBasicRequest(FLARE, { size: '3840x2160', quality: 'high', n: 2 })
    expect(clamped).toEqual({ size: '1664x928', quality: 'medium', n: 2 })
    expect(imageSizeTier(clamped.size)).toBe('1K')
    expect(isGptBasicRequest(clamped)).toBe(true)
  })

  it('is stable: clamping twice gives the same request (submission hashes must match)', () => {
    const once = clampGptBasicRequest(FLARE, { size: '2160x3840', quality: 'high' })
    expect(clampGptBasicRequest(FLARE, once)).toBe(once)
  })

  it('returns the same object when nothing needs to change', () => {
    const request = { size: '1024x1024', quality: 'medium' }
    expect(clampGptBasicRequest(FLARE, request)).toBe(request)
    const other = { size: '3840x2160', quality: 'high' }
    expect(clampGptBasicRequest('gemini-3-pro-image', other)).toBe(other)
  })
})

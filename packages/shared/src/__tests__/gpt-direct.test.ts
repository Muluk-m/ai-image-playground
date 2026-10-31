import { describe, expect, it } from 'bun:test'
import {
  clampGptBasicRequest,
  gptImageRateMultiplier,
  isGptBasicRequest,
  isGptDirectModel,
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
    expect(gptImageRateMultiplier(FLARE, '1024x1024', 'medium')).toBe(1)
    expect(gptImageRateMultiplier(FLARE, '1024x1024', 'low')).toBe(1)
    expect(gptImageRateMultiplier(FLARE, undefined, 'auto')).toBe(1)
    expect(gptImageRateMultiplier(FLARE, '1024x1024', 'high')).toBe(4)
    expect(gptImageRateMultiplier(FLARE, '2048x2048', 'medium')).toBe(2)
    expect(gptImageRateMultiplier(FLARE, '3840x2160', 'high')).toBe(8)
  })

  it('leaves every other model at one', () => {
    expect(gptImageRateMultiplier('gemini-3-pro-image', '3840x2160', 'high')).toBe(1)
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

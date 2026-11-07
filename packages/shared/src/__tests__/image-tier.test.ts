import { describe, expect, it } from 'bun:test'
import type { ImageRateRequest } from '../gpt-direct'
import { type ImageTierEntry, resolveImageTier } from '../image-tier'

const GPT = { model: 'gpt-image-2.5-flare', provider: 'openai-compat' } as const
const GEMINI = { model: 'gemini-3-pro-image', provider: 'gemini' } as const

const GPT_4K_HIGH: ImageRateRequest = { size: '3840x2160', quality: 'high' }
const GEMINI_4K: ImageRateRequest = { image_size: '4K' }

const CEILING_ENTRIES: readonly ImageTierEntry[] = ['agent', 'stage', 'batch', 'look']

function gpt(entry: ImageTierEntry, member: boolean, directAvailable = true) {
  return resolveImageTier({ ...GPT, request: GPT_4K_HIGH, entry, member, directAvailable })
}

function gemini(entry: ImageTierEntry, member: boolean) {
  return resolveImageTier({
    ...GEMINI,
    request: GEMINI_4K,
    entry,
    member,
    directAvailable: true,
  })
}

describe('resolveImageTier · GPT 4K high', () => {
  it('web-direct keeps the member tier only when direct delivery is available', () => {
    expect(gpt('web-direct', true).effectiveRequest).toEqual(GPT_4K_HIGH)
    const noDirect = gpt('web-direct', true, false).effectiveRequest
    expect(noDirect.quality).toBe('medium')
    expect(noDirect.size).not.toBe('3840x2160')
  })

  it('web-direct clamps a non-member to 2K and medium', () => {
    const { effectiveRequest } = gpt('web-direct', false)
    expect(effectiveRequest.quality).toBe('medium')
    const [width, height] = effectiveRequest.size!.split('x').map(Number)
    expect(width! * height!).toBeLessThanOrEqual(4_194_304)
  })

  it.each(CEILING_ENTRIES)('%s clamps even a member', (entry) => {
    const member = gpt(entry, true).effectiveRequest
    expect(member.quality).toBe('medium')
    expect(member).toEqual(gpt(entry, false).effectiveRequest)
  })

  it('cli-strict never rewrites the request, member or not', () => {
    expect(gpt('cli-strict', true).effectiveRequest).toEqual(GPT_4K_HIGH)
    expect(gpt('cli-strict', false).effectiveRequest).toEqual(GPT_4K_HIGH)
  })

  it('is stable: resolving an effective request again changes nothing', () => {
    for (const entry of ['web-direct', 'agent', 'stage', 'batch', 'look'] as const) {
      const once = gpt(entry, false).effectiveRequest
      const twice = resolveImageTier({
        ...GPT,
        request: once,
        entry,
        member: false,
        directAvailable: true,
      })
      expect(twice.effectiveRequest).toEqual(once)
    }
  })
})

describe('resolveImageTier · Gemini 4K', () => {
  it.each([
    'web-direct',
    ...CEILING_ENTRIES,
  ] as const)('%s keeps 4K for a member and drops a non-member to 2K', (entry) => {
    expect(gemini(entry, true).effectiveRequest.image_size).toBe('4K')
    expect(gemini(entry, false).effectiveRequest.image_size).toBe('2K')
  })

  it('cli-strict keeps 4K for everyone', () => {
    expect(gemini('cli-strict', false).effectiveRequest.image_size).toBe('4K')
  })
})

describe('resolveImageTier · rate multiplier', () => {
  it('prices the effective request, not the requested one', () => {
    // GPT 2.5 表：4K high = 8；收到 2K medium 后 = 2。
    expect(gpt('web-direct', true).rateMultiplier).toBe(8)
    expect(gpt('web-direct', false).rateMultiplier).toBe(2)
    expect(gpt('agent', true).rateMultiplier).toBe(2)
    expect(gpt('cli-strict', false).rateMultiplier).toBe(8)
  })

  it('prices Gemini by the tier it will actually run', () => {
    // Pro：2K = 1，4K = 1.8。
    expect(gemini('web-direct', true).rateMultiplier).toBe(1.8)
    expect(gemini('web-direct', false).rateMultiplier).toBe(1)
  })

  it('snaps to the tiers the channel declares', () => {
    const result = resolveImageTier({
      ...GEMINI,
      request: GEMINI_4K,
      entry: 'web-direct',
      member: true,
      directAvailable: true,
      supportedTiers: ['1K', '2K'],
    })
    expect(result.rateMultiplier).toBe(1)
  })
  it('marks GPT Image 2.6 4K as membership-required even when its 2K and 4K rates match', () => {
    const result = resolveImageTier({
      model: 'gpt-image-2.6-flare',
      provider: 'openai-compat',
      request: { size: '3840x2160' },
      entry: 'agent',
      member: false,
      directAvailable: true,
    })
    expect(result.requires.membership).toBe(true)
  })
})

describe('resolveImageTier · requires', () => {
  it('asks a member 4K web request for membership only', () => {
    expect(gpt('web-direct', true).requires).toEqual({ membership: true, directRoute: false })
  })

  it('asks nothing once a non-member was clamped', () => {
    expect(gpt('web-direct', false).requires).toEqual({ membership: false, directRoute: false })
    expect(gemini('agent', false).requires).toEqual({ membership: false, directRoute: false })
  })

  it('asks cli-strict 4K high GPT for membership and the direct route', () => {
    expect(gpt('cli-strict', false).requires).toEqual({ membership: true, directRoute: true })
  })

  it('asks cli-strict 2K medium GPT for the direct route only', () => {
    const result = resolveImageTier({
      ...GPT,
      request: { size: '2560x1440', quality: 'medium' },
      entry: 'cli-strict',
      member: false,
      directAvailable: true,
    })
    expect(result.requires).toEqual({ membership: false, directRoute: true })
  })

  it('asks cli-strict 1K medium GPT for nothing, since sub2api delivers it', () => {
    const result = resolveImageTier({
      ...GPT,
      request: { size: '1024x1024', quality: 'medium' },
      entry: 'cli-strict',
      member: false,
      directAvailable: true,
    })
    expect(result.requires).toEqual({ membership: false, directRoute: false })
  })

  it('asks cli-strict Gemini 4K for membership', () => {
    expect(gemini('cli-strict', false).requires).toEqual({ membership: true, directRoute: false })
  })
})

describe('resolveImageTier · other models', () => {
  it('leaves a model without a tier table untouched at one', () => {
    const request = { size: '3840x2160', quality: 'high' as const }
    const result = resolveImageTier({
      model: 'some-other-model',
      provider: 'openai-compat',
      request,
      entry: 'agent',
      member: false,
      directAvailable: true,
    })
    expect(result.effectiveRequest).toEqual(request)
    expect(result.rateMultiplier).toBe(1)
  })
})

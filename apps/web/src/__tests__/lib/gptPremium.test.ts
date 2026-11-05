import { describe, expect, it } from 'vitest'
import { readGptPremiumBody } from '../../lib/gptPremium'

describe('readGptPremiumBody', () => {
  it('reads the member tier and high-quality flags', () => {
    expect(
      readGptPremiumBody({
        premium: false,
        member: false,
        maxTier: '2K',
        highQuality: false,
      }),
    ).toMatchObject({
      premium: false,
      member: false,
      maxTier: '2K',
      highQuality: false,
      locked: true,
      memberOnly: true,
    })
    expect(
      readGptPremiumBody({ premium: true, member: true, maxTier: '4K', highQuality: true }),
    ).toMatchObject({
      maxTier: '4K',
      highQuality: true,
      locked: false,
      memberOnly: false,
    })
  })

  it('keeps an older payload that only sends premium', () => {
    expect(readGptPremiumBody({ premium: true })).toMatchObject({
      member: true,
      maxTier: '4K',
      highQuality: true,
    })
    expect(readGptPremiumBody({ premium: false })).toMatchObject({
      member: false,
      maxTier: '2K',
      highQuality: false,
    })
  })
})

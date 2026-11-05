import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readGptPremiumBody, useGptPremiumLocked } from '../../lib/gptPremium'

const account = vi.hoisted(() => ({ id: 'gemini-member' }))
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: account }) }))
vi.mock('../../lib/runtimeConfig', () => ({ bffBaseUrl: () => '' }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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

it.each([true, false])('reads Gemini membership with GPT off: %s', async (member) => {
  account.id = `gemini-member-${member}`
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ premium: false, member, maxTier: '2K', highQuality: false }),
      ),
    ),
  )
  const { result } = renderHook(() => useGptPremiumLocked('gemini-nano-banana-2.1', false))
  await waitFor(() => expect(result.current.settled).toBe(true))
  expect(result.current.member).toBe(member)
  expect(result.current.maxTier).toBe(member ? '4K' : '2K')
})

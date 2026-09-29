import type { ClientCapabilityKey } from '@image-playground/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bootstrapClientCapabilities,
  getClientCapabilityManifest,
  isByokGenerationEnabled,
  isClientCapabilityEnabled,
} from '../../lib/clientCapabilities'
import { allCapabilitiesOff } from '../fixtures/capabilities'

afterEach(async () => {
  vi.unstubAllGlobals()
  await bootstrapClientCapabilities(false, '')
})

describe('client capability bootstrap', () => {
  it('loads only the BFF manifest and resolves enabled capabilities', async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json({
        ...allCapabilitiesOff(),
        'accounts:login': true,
        'accounts:self-register': true,
        'accounts:sync': true,
        'generation:byok': true,
      }),
    )
    vi.stubGlobal('fetch', fetchSpy)

    await bootstrapClientCapabilities(true, 'https://bff.example.com/')

    expect(isClientCapabilityEnabled('accounts:login')).toBe(true)
    expect(isClientCapabilityEnabled('accounts:self-register')).toBe(true)
    expect(isClientCapabilityEnabled('generation:byok')).toBe(true)
    expect(getClientCapabilityManifest()).not.toHaveProperty('operator:console')
  })

  it('keeps known capabilities enabled when an older server omits newer keys', async () => {
    const legacyManifest: Partial<Record<ClientCapabilityKey, boolean>> = {
      ...allCapabilitiesOff(),
      'accounts:login': true,
      'billing:credits': true,
    }
    delete legacyManifest['agent:chat']
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(legacyManifest)),
    )

    await bootstrapClientCapabilities(true, 'https://bff.example.com')

    expect(isClientCapabilityEnabled('accounts:login')).toBe(true)
    expect(isClientCapabilityEnabled('billing:credits')).toBe(true)
    expect(isClientCapabilityEnabled('agent:chat')).toBe(false)
    expect(isByokGenerationEnabled()).toBe(false)
  })

  it('fails closed for a disabled backend or a malformed capability value', async () => {
    await bootstrapClientCapabilities(false, '')
    expect(Object.values(getClientCapabilityManifest()).every((value) => value === false)).toBe(
      true,
    )

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ 'accounts:login': 'true', 'generation:byok': true })),
    )
    await bootstrapClientCapabilities(true, '')

    expect(Object.values(getClientCapabilityManifest()).every((value) => value === false)).toBe(
      true,
    )
  })

  it('keeps static BYOK enabled but fails closed for BFF deployments', async () => {
    await bootstrapClientCapabilities(false, '')
    expect(isByokGenerationEnabled()).toBe(true)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ...allCapabilitiesOff(),
        }),
      ),
    )
    await bootstrapClientCapabilities(true, '')
    expect(isByokGenerationEnabled()).toBe(false)
  })

  it('bounds a stalled capability request and fails closed', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise(() => {})),
      )
      const boot = bootstrapClientCapabilities(true, '')
      await vi.advanceTimersByTimeAsync(5000)
      await boot
      expect(isClientCapabilityEnabled('accounts:login')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a timed-out required startup manifest so the UI can retry', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise(() => {})),
      )
      const boot = bootstrapClientCapabilities(true, '', true)
      const outcome = expect(boot).rejects.toThrow('capability_request_timeout')
      await vi.advanceTimersByTimeAsync(5000)
      await outcome
    } finally {
      vi.useRealTimers()
    }
  })
})

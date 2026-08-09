import { CAPABILITIES } from '@image-playground/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bootstrapClientCapabilities,
  getClientCapabilityManifest,
  isByokGenerationEnabled,
  isClientCapabilityEnabled,
} from '../../lib/clientCapabilities'

afterEach(async () => {
  vi.unstubAllGlobals()
  await bootstrapClientCapabilities(false, '')
})

describe('client capability bootstrap', () => {
  it('loads only the BFF manifest and resolves enabled capabilities', async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json({
        'accounts:login': true,
        'billing:credits': false,
        'generation:byok': true,
        'quota:daily': false,
      }),
    )
    vi.stubGlobal('fetch', fetchSpy)

    await bootstrapClientCapabilities(true, 'https://bff.example.com/')

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://bff.example.com/api/capabilities',
      expect.objectContaining({ cache: 'no-store' }),
    )
    expect(isClientCapabilityEnabled('accounts:login')).toBe(true)
    expect(isClientCapabilityEnabled('generation:byok')).toBe(true)
    expect(getClientCapabilityManifest()).not.toHaveProperty('operator:console')
  })

  it('fails closed when the backend is absent, unreachable, or returns an invalid manifest', async () => {
    await bootstrapClientCapabilities(false, '')
    expect(Object.values(getClientCapabilityManifest()).every((value) => value === false)).toBe(
      true,
    )

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ 'accounts:login': true })),
    )
    await bootstrapClientCapabilities(true, '')

    const exposedCount = Object.values(CAPABILITIES).filter(
      (definition) => definition.clientExposed,
    ).length
    expect(Object.keys(getClientCapabilityManifest())).toHaveLength(exposedCount)
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
          'accounts:login': false,
          'billing:credits': false,
          'generation:byok': false,
          'quota:daily': false,
        }),
      ),
    )
    await bootstrapClientCapabilities(true, '')
    expect(isByokGenerationEnabled()).toBe(false)
  })
})

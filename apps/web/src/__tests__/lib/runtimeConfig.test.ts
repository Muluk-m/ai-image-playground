import { BAKED_DEFAULTS, type RuntimeConfig } from '@image-playground/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _setRuntimeConfigForTesting,
  getRuntimeConfig,
  loadRuntimeConfig,
} from '../../lib/runtimeConfig'

const VALID_CONFIG: RuntimeConfig = {
  bff: { enabled: true, baseUrl: 'https://bff.example.com' },
  auth: { enabled: true },
  defaults: {
    openaiBaseUrl: 'https://api.example.com/v1',
    geminiBaseUrl: 'https://gemini.example.com/v1beta',
    inspirationManifestUrl: 'https://cdn.example.com/manifest.json',
  },
}

function mockFetch(
  status: number,
  body: unknown,
  opts: { rejectWith?: Error; rawText?: string } = {},
): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    if (opts.rejectWith) throw opts.rejectWith
    void input
    void init
    return new Response(opts.rawText ?? JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
}

describe('loadRuntimeConfig', () => {
  beforeEach(() => {
    _setRuntimeConfigForTesting(BAKED_DEFAULTS)
  })
  afterEach(() => {
    _setRuntimeConfigForTesting(BAKED_DEFAULTS)
  })

  it('returns the parsed config when file present and valid', async () => {
    const result = await loadRuntimeConfig(mockFetch(200, VALID_CONFIG))
    expect(result).toEqual(VALID_CONFIG)
    expect(getRuntimeConfig()).toEqual(VALID_CONFIG)
  })

  it('falls back to BAKED_DEFAULTS on 404', async () => {
    const result = await loadRuntimeConfig(mockFetch(404, ''))
    expect(result).toEqual(BAKED_DEFAULTS)
    expect(getRuntimeConfig()).toEqual(BAKED_DEFAULTS)
  })

  it('falls back to BAKED_DEFAULTS on malformed JSON', async () => {
    const result = await loadRuntimeConfig(mockFetch(200, null, { rawText: '{not json' }))
    expect(result).toEqual(BAKED_DEFAULTS)
  })

  it('falls back to BAKED_DEFAULTS on schema mismatch', async () => {
    const result = await loadRuntimeConfig(mockFetch(200, { bff: 'oops' }))
    expect(result).toEqual(BAKED_DEFAULTS)
  })

  it('falls back to BAKED_DEFAULTS on network rejection', async () => {
    const result = await loadRuntimeConfig(mockFetch(0, null, { rejectWith: new Error('network') }))
    expect(result).toEqual(BAKED_DEFAULTS)
  })

  it('strips trailing slash from bff.baseUrl', async () => {
    const result = await loadRuntimeConfig(
      mockFetch(200, {
        ...VALID_CONFIG,
        bff: { enabled: true, baseUrl: 'https://bff.example.com//' },
      }),
    )
    expect(result.bff.baseUrl).toBe('https://bff.example.com')
  })

  it('defaults missing legacy auth config to disabled', async () => {
    const { auth: _auth, ...legacyConfig } = VALID_CONFIG
    void _auth
    const result = await loadRuntimeConfig(mockFetch(200, legacyConfig))
    expect(result.auth).toEqual({ enabled: false })
  })

  it('rejects non-boolean auth.enabled', async () => {
    const result = await loadRuntimeConfig(
      mockFetch(200, {
        ...VALID_CONFIG,
        auth: { enabled: 'true' },
      }),
    )
    expect(result).toEqual(BAKED_DEFAULTS)
  })

  it('persists last loaded config across multiple calls', async () => {
    await loadRuntimeConfig(mockFetch(200, VALID_CONFIG))
    expect(getRuntimeConfig()).toEqual(VALID_CONFIG)
    // Now simulate a re-load that fails — should still update cache to defaults.
    await loadRuntimeConfig(mockFetch(404, ''))
    expect(getRuntimeConfig()).toEqual(BAKED_DEFAULTS)
  })
})

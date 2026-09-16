import { BAKED_DEFAULTS, type RuntimeConfig } from '@image-playground/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCurrentUser } from '../../lib/authClient'
import {
  _setRuntimeConfigForTesting,
  getRuntimeConfig,
  loadRuntimeConfig,
} from '../../lib/runtimeConfig'

const VALID_CONFIG: RuntimeConfig = {
  bff: { enabled: true, baseUrl: 'https://bff.example.com' },
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
    vi.unstubAllGlobals()
    _setRuntimeConfigForTesting(BAKED_DEFAULTS)
  })

  it('共享发布包在旧站使用原 API 恢复已有登录，在新站使用新 API', async () => {
    const config = {
      bff: {
        enabled: true,
        baseUrl: 'https://api.muvloom.online',
        baseUrlsByOrigin: { 'https://image.nainma.online': 'https://api.nainma.online' },
      },
    }
    vi.stubGlobal('location', { origin: 'https://image.nainma.online' })
    const legacy = await loadRuntimeConfig(mockFetch(200, config))
    expect(legacy.bff.baseUrl).toBe('https://api.nainma.online')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (url === 'https://api.nainma.online/api/auth/me' && init.credentials === 'include')
          return Response.json({ user: { id: 'existing-user', username: 'existing@example.test' } })
        return Response.json({ error: 'unauthorized' }, { status: 401 })
      }),
    )
    expect(await getCurrentUser()).toMatchObject({ id: 'existing-user' })
    vi.stubGlobal('location', { origin: 'https://muvloom.online' })
    expect((await loadRuntimeConfig(mockFetch(200, config))).bff.baseUrl).toBe(
      'https://api.muvloom.online',
    )
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

  it('discards legacy feature and default fields instead of creating a second feature source', async () => {
    const result = await loadRuntimeConfig(
      mockFetch(200, {
        ...VALID_CONFIG,
        auth: { enabled: true },
        defaults: { openaiBaseUrl: 'https://example.com' },
      }),
    )
    expect(result).toEqual(VALID_CONFIG)
  })

  it('persists last loaded config across multiple calls', async () => {
    await loadRuntimeConfig(mockFetch(200, VALID_CONFIG))
    expect(getRuntimeConfig()).toEqual(VALID_CONFIG)
    // Now simulate a re-load that fails — should still update cache to defaults.
    await loadRuntimeConfig(mockFetch(404, ''))
    expect(getRuntimeConfig()).toEqual(BAKED_DEFAULTS)
  })
})

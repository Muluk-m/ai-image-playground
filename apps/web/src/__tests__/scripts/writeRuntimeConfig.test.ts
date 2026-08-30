import { describe, expect, it } from 'vitest'

import { buildRuntimeConfig } from '../../../scripts/write-runtime-config.mjs'

describe('buildRuntimeConfig', () => {
  it('falls back to the BYOK-only shape when the backend is not enabled', () => {
    expect(buildRuntimeConfig({})).toEqual({ bff: { enabled: false, baseUrl: '' } })
  })

  it('strips trailing slashes from the backend origin', () => {
    expect(
      buildRuntimeConfig({ BFF_ENABLED: 'true', BFF_BASE_URL: 'https://api.example.com//' }),
    ).toEqual({ bff: { enabled: true, baseUrl: 'https://api.example.com' } })
  })

  it('rejects an enabled backend without an origin, because static hosting is never same-origin', () => {
    expect(() => buildRuntimeConfig({ BFF_ENABLED: 'true' })).toThrow(/BFF_BASE_URL is required/)
  })

  it('rejects a relative origin', () => {
    expect(() => buildRuntimeConfig({ BFF_ENABLED: 'true', BFF_BASE_URL: '/api' })).toThrow(
      /absolute URL/,
    )
  })

  it('rejects an origin carrying a query string', () => {
    expect(() =>
      buildRuntimeConfig({ BFF_ENABLED: 'true', BFF_BASE_URL: 'https://api.example.com?token=x' }),
    ).toThrow(/query string/)
  })

  it('rejects an origin set while the backend stays disabled', () => {
    expect(() => buildRuntimeConfig({ BFF_BASE_URL: 'https://api.example.com' })).toThrow(
      /BFF_ENABLED is not true/,
    )
  })

  it('rejects a non-boolean switch instead of guessing', () => {
    expect(() => buildRuntimeConfig({ BFF_ENABLED: '1' })).toThrow(/must be true or false/)
  })
})

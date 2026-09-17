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

  it('publishes validated per-origin API routing in the shared bundle', () => {
    expect(
      buildRuntimeConfig({
        BFF_ENABLED: 'true',
        BFF_BASE_URL: 'https://api.new.test',
        BFF_BASE_URLS_BY_ORIGIN: JSON.stringify({
          'https://legacy.old.test/': 'https://api.old.test/',
        }),
      }),
    ).toEqual({
      bff: {
        enabled: true,
        baseUrl: 'https://api.new.test',
        baseUrlsByOrigin: { 'https://legacy.old.test': 'https://api.old.test' },
      },
    })
  })

  it('rejects invalid origin maps before publishing a broken login configuration', () => {
    for (const value of [
      null,
      [],
      { 'https://old.test': 'javascript:alert(1)' },
      { 'https://old.test': 'https://user:password@api.old.test' },
      { 'https://old.test/path': 'https://api.old.test' },
      { 'https://old.test': 42 },
    ]) {
      expect(() =>
        buildRuntimeConfig({
          BFF_ENABLED: 'true',
          BFF_BASE_URL: 'https://api.new.test',
          BFF_BASE_URLS_BY_ORIGIN: JSON.stringify(value),
        }),
      ).toThrow()
    }
  })
})

it('publishes only exact HTTPS origins for browser-local compatibility', async () => {
  const { parseRuntimeConfig } = await import('@image-playground/shared')
  const localCompatibility = {
    sourceOrigin: 'https://old.example.test',
    targetOrigin: 'https://new.example.test',
  }
  const config = buildRuntimeConfig({
    BFF_ENABLED: 'true',
    BFF_BASE_URL: 'https://api.example.test',
    LOCAL_COMPATIBILITY: JSON.stringify(localCompatibility),
  })
  expect(parseRuntimeConfig(config).localCompatibility).toEqual(localCompatibility)
  for (const sourceOrigin of [
    'https://old.example.test/path',
    'http://old.example.test',
    localCompatibility.targetOrigin,
  ]) {
    expect(() =>
      buildRuntimeConfig({
        BFF_ENABLED: 'true',
        BFF_BASE_URL: 'https://api.example.test',
        LOCAL_COMPATIBILITY: JSON.stringify({ ...localCompatibility, sourceOrigin }),
      }),
    ).toThrow()
    expect(() =>
      parseRuntimeConfig({
        ...config,
        localCompatibility: { ...localCompatibility, sourceOrigin },
      }),
    ).toThrow()
  }
})

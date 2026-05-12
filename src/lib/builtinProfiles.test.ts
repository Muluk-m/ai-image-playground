import { describe, expect, it } from 'vitest'
import { parseBuiltinProfiles } from './builtinProfiles'

describe('parseBuiltinProfiles', () => {
  it('returns empty array for undefined / empty / invalid JSON', () => {
    expect(parseBuiltinProfiles(undefined)).toEqual([])
    expect(parseBuiltinProfiles('')).toEqual([])
    expect(parseBuiltinProfiles('not-json')).toEqual([])
    expect(parseBuiltinProfiles('{}')).toEqual([])
  })

  it('parses an array and enforces builtin- id prefix', () => {
    const json = JSON.stringify([
      { id: 'gemini-flash', name: 'Flash', provider: 'gemini', baseUrl: 'https://x/v1beta', apiKey: 'k', model: 'gemini-3.1-flash-image' },
      { id: 'builtin-gemini-pro', name: 'Pro', provider: 'gemini', baseUrl: 'https://x/v1beta', apiKey: 'k', model: 'gemini-3-pro-preview' },
    ])
    const profiles = parseBuiltinProfiles(json)
    expect(profiles).toHaveLength(2)
    expect(profiles[0].id).toBe('builtin-gemini-flash')
    expect(profiles[1].id).toBe('builtin-gemini-pro')
    expect(profiles[0].provider).toBe('gemini')
  })

  it('still produces builtin id for malformed entries', () => {
    const json = JSON.stringify([{ name: 'invalid' }])
    const result = parseBuiltinProfiles(json)
    expect(result).toHaveLength(1)
    expect(result[0].id.startsWith('builtin-')).toBe(true)
  })

  it('deduplicates by id', () => {
    const json = JSON.stringify([
      { id: 'a', name: 'A', provider: 'gemini', baseUrl: 'https://x', apiKey: 'k', model: 'm' },
      { id: 'a', name: 'A2', provider: 'gemini', baseUrl: 'https://x', apiKey: 'k', model: 'm' },
    ])
    const profiles = parseBuiltinProfiles(json)
    expect(profiles).toHaveLength(2)
    expect(profiles.map((p) => p.id)).toEqual(['builtin-a', 'builtin-a-2'])
  })
})

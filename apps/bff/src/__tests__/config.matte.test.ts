import { afterEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.MATTE_TRANSFORM_ORIGIN = 'https://bff.example.com/'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, './matte-operator-config.json')

// Dynamic import keeps environment setup ahead of configuration module evaluation.
const { config } = await import('../config')

afterEach(() => {
  process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
  process.env.MATTE_TRANSFORM_ORIGIN = 'https://bff.example.com/'
})

describe('config.assertValid with matte:server enabled', () => {
  it('accepts a bare https origin and drops its trailing slash', () => {
    expect(() => config.assertValid()).not.toThrow()
    expect(config.matte.transformOrigin).toBe('https://bff.example.com')
  })

  it('refuses an empty internal token', () => {
    process.env.INTERNAL_API_TOKEN = ''
    expect(() => config.assertValid()).toThrow('Missing env: INTERNAL_API_TOKEN')
  })

  it('refuses a missing transform origin', () => {
    process.env.MATTE_TRANSFORM_ORIGIN = ''
    expect(() => config.assertValid()).toThrow('Missing env: MATTE_TRANSFORM_ORIGIN')
  })

  it('refuses plain http, a path, a query, a fragment and a non-URL', () => {
    const rejected = [
      'http://bff.example.com',
      'https://bff.example.com/matte',
      'https://bff.example.com/?a=1',
      'https://bff.example.com/#a',
      'bff.example.com',
    ]
    for (const origin of rejected) {
      process.env.MATTE_TRANSFORM_ORIGIN = origin
      expect(() => config.assertValid()).toThrow('must be a bare https:// origin')
    }
  })
})

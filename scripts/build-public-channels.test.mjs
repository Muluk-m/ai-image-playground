import { describe, expect, it } from 'vitest'
import { buildPublicChannels } from './build-public-channels.mjs'

const validChannel = {
  id: 'test-openai',
  kind: 'openai-compat',
  label: 'Test',
  baseUrl: 'https://api.example.com/v1',
  auth: { type: 'bearer', secretRef: 'TEST_KEY' },
  models: [{ id: 'm1', label: 'M1', capabilities: ['generate'] }],
  defaults: { apiMode: 'images', timeout: 600 },
  allowedPaths: ['images/generations'],
}

describe('buildPublicChannels', () => {
  it('strips baseUrl/auth/allowedPaths from public view', () => {
    const result = buildPublicChannels({ channels: [validChannel] })
    expect(result.errors).toEqual([])
    expect(result.output.channels).toHaveLength(1)
    const ch = result.output.channels[0]
    expect(ch).toHaveProperty('id', 'test-openai')
    expect(ch).toHaveProperty('kind', 'openai-compat')
    expect(ch).toHaveProperty('models')
    expect(ch).toHaveProperty('defaults')
    expect(ch).not.toHaveProperty('baseUrl')
    expect(ch).not.toHaveProperty('auth')
    expect(ch).not.toHaveProperty('allowedPaths')
  })

  it('rejects missing auth.secretRef', () => {
    const broken = { ...validChannel, auth: { type: 'bearer' } }
    const result = buildPublicChannels({ channels: [broken] })
    expect(result.errors.some((m) => m.includes('auth.secretRef'))).toBe(true)
    expect(result.output).toBeNull()
  })

  it('rejects duplicate ids', () => {
    const result = buildPublicChannels({ channels: [validChannel, validChannel] })
    expect(result.errors.some((m) => m.includes('与前面记录重复'))).toBe(true)
  })

  it('rejects secretRef that looks like a real OpenAI key', () => {
    const broken = { ...validChannel, auth: { type: 'bearer', secretRef: 'sk-1234567890abcdefghij' } }
    const result = buildPublicChannels({ channels: [broken] })
    expect(result.errors.some((m) => m.includes('疑似真密钥'))).toBe(true)
  })

  it('rejects secretRef that looks like a real Google AIza key', () => {
    const broken = { ...validChannel, auth: { type: 'query-key', secretRef: 'AIzaSyD-abcdefghijklmnopqrstuv', queryParam: 'key' } }
    const result = buildPublicChannels({ channels: [broken] })
    expect(result.errors.some((m) => m.includes('疑似真密钥'))).toBe(true)
  })

  it('passes UPPER_SNAKE_CASE env var names even when they look long', () => {
    const ok = { ...validChannel, auth: { type: 'bearer', secretRef: 'SUB2API_GEMINI_FLASH_IMAGE_PREVIEW_KEY' } }
    const result = buildPublicChannels({ channels: [ok] })
    expect(result.errors).toEqual([])
  })

  it('rejects non-kebab-case id', () => {
    const broken = { ...validChannel, id: 'Test_OpenAI' }
    const result = buildPublicChannels({ channels: [broken] })
    expect(result.errors.some((m) => m.includes('kebab-case'))).toBe(true)
  })

  it('rejects unknown kind', () => {
    const broken = { ...validChannel, kind: 'unknown-kind' }
    const result = buildPublicChannels({ channels: [broken] })
    expect(result.errors.some((m) => m.includes('kind'))).toBe(true)
  })

  it('rejects empty allowedPaths', () => {
    const broken = { ...validChannel, allowedPaths: [] }
    const result = buildPublicChannels({ channels: [broken] })
    expect(result.errors.some((m) => m.includes('allowedPaths'))).toBe(true)
  })

  it('preserves disabled flag in public view', () => {
    const result = buildPublicChannels({ channels: [{ ...validChannel, disabled: true }] })
    expect(result.errors).toEqual([])
    expect(result.output.channels[0].disabled).toBe(true)
  })

  it('rejects non-object root', () => {
    const result = buildPublicChannels({})
    expect(result.errors.length).toBeGreaterThan(0)
  })
})

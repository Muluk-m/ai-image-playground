import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) throw new Error('TEST_DATABASE_URL is required for PostgreSQL tests')

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.CORS_ALLOWED_ORIGINS = '*'

const { app } = await import('../../app')
const { _setChannelsForTesting, parseChannelsConfig } = await import('../../lib/channels')

const ENV_WITH_SECRETS = (k: string): string | undefined =>
  ({ TEST_OPENAI_KEY: 'sk-test', TEST_GEMINI_KEY: 'gem-test' })[k]

function buildInternalChannels() {
  const result = parseChannelsConfig(
    {
      channels: [
        {
          id: 'test-openai',
          kind: 'openai-queue',
          label: 'Test OpenAI',
          baseUrl: 'https://upstream-secret.example.com/v1',
          auth: { type: 'bearer', secretRef: 'TEST_OPENAI_KEY' },
          models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit'] }],
          defaults: { apiMode: 'images', timeout: 600 },
          allowedPaths: ['images/generations'],
        },
        {
          id: 'test-gemini',
          kind: 'gemini-queue',
          label: 'Test Gemini',
          baseUrl: 'https://gemini-secret.example.com/v1beta',
          auth: { type: 'query-key', secretRef: 'TEST_GEMINI_KEY', queryParam: 'key' },
          models: [{ id: 'gemini-flash', label: 'Gemini Flash', capabilities: ['generate'] }],
          defaults: { responseFormatB64Json: false },
          allowedPaths: ['models/gemini-flash:generateContent'],
        },
      ],
    },
    ENV_WITH_SECRETS,
  )
  return result.channels
}

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const res = await app.handle(new Request(`http://localhost${path}`))
  return { status: res.status, body: await res.json() }
}

describe('GET /api/channels', () => {
  beforeEach(() => {
    _setChannelsForTesting([])
  })
  afterEach(() => {
    _setChannelsForTesting([])
  })

  it('returns empty channels array when none loaded', async () => {
    const { status, body } = await getJson('/api/channels')
    expect(status).toBe(200)
    expect(body).toEqual({ channels: [] })
  })

  it('returns sanitized channels (no baseUrl / auth / allowedPaths)', async () => {
    _setChannelsForTesting(buildInternalChannels())
    const { status, body } = await getJson('/api/channels')
    expect(status).toBe(200)

    expect(body).toMatchObject({
      channels: [
        { id: 'test-openai', kind: 'openai-queue', label: 'Test OpenAI' },
        { id: 'test-gemini', kind: 'gemini-queue', label: 'Test Gemini' },
      ],
    })
    const channels = (body as { channels: Record<string, unknown>[] }).channels
    for (const ch of channels) {
      expect(ch).not.toHaveProperty('baseUrl')
      expect(ch).not.toHaveProperty('auth')
      expect(ch).not.toHaveProperty('allowedPaths')
      expect(ch).toHaveProperty('models')
      expect(ch).toHaveProperty('defaults')
    }
  })

  it('serialized response does not leak internal upstream URL or secret', async () => {
    _setChannelsForTesting(buildInternalChannels())
    const res = await app.handle(new Request('http://localhost/api/channels'))
    const text = await res.text()
    expect(text).not.toContain('upstream-secret.example.com')
    expect(text).not.toContain('gemini-secret.example.com')
    expect(text).not.toContain('sk-test')
    expect(text).not.toContain('gem-test')
    expect(text).not.toContain('TEST_OPENAI_KEY')
    expect(text).not.toContain('TEST_GEMINI_KEY')
  })
})

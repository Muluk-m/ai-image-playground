import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ChannelDiscoveryResponse } from '@image-playground/shared'

const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) throw new Error('TEST_DATABASE_URL is required for PostgreSQL tests')

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.CORS_ALLOWED_ORIGINS = '*'

const { app } = await import('../../app')
const { _setChannelsForTesting, parseChannelsConfig } = await import('../../lib/channels')
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)

/** 装一个只回答「哪些模型停用了」的 overlay；其余钩子沿用空实现。 */
function stopModels(answer: () => Promise<ReadonlySet<string>>): void {
  _setPrivateBffOverlayForTesting(
    Object.freeze({
      ...EMPTY_PRIVATE_BFF_OVERLAY,
      present: true,
      taskHooks: { ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks, inactiveModels: answer },
    }),
  )
}

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
          models: [
            { id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit'] },
            { id: 'gpt-image-2-mini', label: 'GPT Image 2 Mini', capabilities: ['generate'] },
          ],
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

/** 发现接口的线上契约就是 `ChannelDiscoveryResponse`；按它读，别在每条断言里现编形状。 */
async function discovered(): Promise<ChannelDiscoveryResponse['channels']> {
  const res = await app.handle(new Request('http://localhost/api/channels'))
  expect(res.status).toBe(200)
  const body: ChannelDiscoveryResponse = await res.json()
  return body.channels
}

describe('GET /api/channels', () => {
  beforeEach(() => {
    _setChannelsForTesting([])
  })
  afterEach(() => {
    _setChannelsForTesting([])
    _setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
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

  // 运营在后台停用一个模型，页面上就不该再有它的入口：点进去只会换来一次失败。
  it('drops models the operator stopped, and a channel once none of its models are left', async () => {
    _setChannelsForTesting(buildInternalChannels())
    stopModels(async () => new Set(['gpt-image-2-mini', 'gemini-flash']))

    const channels = await discovered()

    expect(channels.map((channel) => channel.id)).toEqual(['test-openai'])
    expect(channels[0]!.models.map((model) => model.id)).toEqual(['gpt-image-2'])
  })

  // 停用清单查不到（库抖了）时宁可多露一个停用模型——它的提交在预扣那一步本来就会被拒——
  // 也不能让页面拿不到模型列表、整个工作台用不了。
  it('still lists every model when the stopped-model lookup fails', async () => {
    _setChannelsForTesting(buildInternalChannels())
    stopModels(async () => {
      throw new Error('database unavailable')
    })

    const channels = await discovered()
    expect(channels.map((channel) => channel.id)).toEqual(['test-openai', 'test-gemini'])
  })
})

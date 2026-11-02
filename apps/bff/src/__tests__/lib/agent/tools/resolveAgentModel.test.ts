import { afterAll, describe, expect, it } from 'bun:test'

// 只解析模型，一句 SQL 都不发；库名故意不可达，真连上就会立刻炸出来。
process.env.DATABASE_URL = 'postgres://unused/agent-resolve-model'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_IMAGE_MODEL = 'agnes-image-2.5-flash'
process.env.LOG_LEVEL = 'silent'

const { resolveAgentModel } = await import('../../../../lib/agent/tools/queueTask')
const { _setChannelsForTesting } = await import('../../../../lib/channels')

type InternalChannel = import('../../../../lib/channels').InternalChannel

function imageChannel(id: string, modelId: string): InternalChannel {
  return {
    id,
    kind: 'openai-queue',
    label: id,
    baseUrl: 'https://gateway.test/v1',
    auth: { type: 'bearer', secretRef: 'FIXTURE_KEY', secret: 'k' },
    allowedPaths: ['images/generations'],
    models: [{ id: modelId, label: modelId, capabilities: ['generate', 'edit'] }],
    defaults: {},
  }
}

afterAll(() => {
  _setChannelsForTesting([])
})

describe('resolveAgentModel', () => {
  it('falls back to the first live image model when the configured one is disabled', () => {
    _setChannelsForTesting(
      [imageChannel('openai-images', 'gpt-image-2.5-flare')],
      [imageChannel('agnes-images', 'agnes-image-2.5-flash')],
    )

    expect(resolveAgentModel('image')?.model).toBe('gpt-image-2.5-flare')
    // 用户这一轮选的模型也被下线时，同样不让整轮失败。
    expect(resolveAgentModel('image', 'agnes-image-2.5-flash')?.model).toBe('gpt-image-2.5-flare')
  })

  it('keeps the configured model while it is live', () => {
    _setChannelsForTesting([
      imageChannel('openai-images', 'gpt-image-2.5-flare'),
      imageChannel('agnes-images', 'agnes-image-2.5-flash'),
    ])

    expect(resolveAgentModel('image')?.model).toBe('agnes-image-2.5-flash')
  })
})

describe('resolveAgentModel skips models paused on the admin model page', () => {
  const channels = () =>
    _setChannelsForTesting([
      imageChannel('openai-images', 'gpt-image-2.5-flare'),
      imageChannel('agnes-images', 'agnes-image-2.5-flash'),
      imageChannel('vertex-images', 'gemini-nano-banana-2.1'),
      imageChannel('vertex-pro', 'gemini-3-pro-image'),
    ])

  it('falls back to gemini-nano-banana-2.1 when the configured model is paused', () => {
    channels()
    expect(resolveAgentModel('image', undefined, new Set(['agnes-image-2.5-flash']))?.model).toBe(
      'gemini-nano-banana-2.1',
    )
  })

  it('also skips a paused model the user picked this turn', () => {
    channels()
    const paused = new Set(['gpt-image-2.5-flare'])
    expect(resolveAgentModel('image', 'gpt-image-2.5-flare', paused)?.model).toBe(
      'agnes-image-2.5-flash',
    )
    expect(
      resolveAgentModel(
        'image',
        'gpt-image-2.5-flare',
        new Set([...paused, 'agnes-image-2.5-flash']),
      )?.model,
    ).toBe('gemini-nano-banana-2.1')
  })

  it('takes the first live model when the preferred fallback is paused too', () => {
    channels()
    expect(
      resolveAgentModel(
        'image',
        undefined,
        new Set(['agnes-image-2.5-flash', 'gemini-nano-banana-2.1', 'gpt-image-2.5-flare']),
      )?.model,
    ).toBe('gemini-3-pro-image')
  })

  it('gives up when every image model is paused', () => {
    channels()
    expect(
      resolveAgentModel(
        'image',
        undefined,
        new Set([
          'agnes-image-2.5-flash',
          'gemini-nano-banana-2.1',
          'gpt-image-2.5-flare',
          'gemini-3-pro-image',
        ]),
      ),
    ).toBeUndefined()
  })

  it('leaves a live user choice alone', () => {
    channels()
    expect(resolveAgentModel('image', 'gpt-image-2.5-flare', new Set())?.model).toBe(
      'gpt-image-2.5-flare',
    )
  })
})

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

import { afterEach, describe, expect, it } from 'bun:test'
import { findCatalogModel } from '@image-playground/shared/model-catalog'
import {
  _setChannelsForTesting,
  getDiscoveredChannels,
  parseChannelsConfig,
} from '../../lib/channels'

/**
 * PR-2（ADR 0027）：发现接口在图片模型上附带能力目录的 family 与 image，只增不删。
 * 现有字段必须原样保留，目录外的模型和视频模型不加字段，前端旧代码看到的东西不变。
 */

const ENV = (key: string): string | undefined => ({ TEST_KEY: 'sk-test' })[key]

function load() {
  const { channels } = parseChannelsConfig(
    {
      channels: [
        {
          id: 'gpt',
          kind: 'openai-queue',
          label: 'OpenAI',
          baseUrl: 'https://upstream-secret.example.com/v1',
          auth: { type: 'bearer', secretRef: 'TEST_KEY' },
          models: [
            {
              id: 'gpt-image-2.5-flare',
              label: 'GPT Image 2.5 Flare',
              capabilities: ['generate', 'edit', 'mask', 'quality', 'n', 'moderation'],
            },
            { id: 'not-in-catalog', label: 'Other', capabilities: ['generate'] },
            // 故意借一个目录里有的 id：媒介是视频就不该拿到图片能力。
            {
              id: 'grok-imagine-image-2.0',
              label: 'Video',
              media: 'video',
              capabilities: ['duration'],
            },
          ],
          defaults: { apiMode: 'images' },
          allowedPaths: ['images/generations'],
        },
        {
          id: 'gemini',
          kind: 'gemini-queue',
          label: 'Gemini',
          baseUrl: 'https://gemini-secret.example.com/v1beta',
          auth: { type: 'query-key', secretRef: 'TEST_KEY', queryParam: 'key' },
          models: [
            { id: 'gemini-3-pro-image', label: 'Nano Banana Pro', capabilities: ['generate'] },
          ],
          defaults: {},
          allowedPaths: ['models/gemini-3-pro-image:generateContent'],
        },
      ],
    },
    ENV,
  )
  _setChannelsForTesting(channels)
  return getDiscoveredChannels()
}

const modelOf = (id: string) =>
  load()
    .flatMap((channel) => channel.models)
    .find((model) => model.id === id)!

describe('discovered channels carry catalog capabilities', () => {
  afterEach(() => _setChannelsForTesting([]))

  it('adds family and image to catalog image models and keeps every existing field', () => {
    const model = modelOf('gpt-image-2.5-flare')
    expect(model).toMatchObject({
      id: 'gpt-image-2.5-flare',
      label: 'GPT Image 2.5 Flare',
      capabilities: ['generate', 'edit', 'mask', 'quality', 'n', 'moderation'],
      family: 'gpt',
    })
    const { wire: _wire, ...expected } = findCatalogModel('gpt-image-2.5-flare')!.image
    expect(model.image).toEqual(expected)
  })

  it('publishes the measured tiers and the per-surface ratios', () => {
    const flare = modelOf('gpt-image-2.5-flare').image!
    expect(flare.tiers.map((tier) => tier.id)).toEqual(['1K', '2K', '4K'])
    expect(flare.tiers[2]?.pixels['16:9']).toBe('3840x2160')
    const pro = modelOf('gemini-3-pro-image').image!
    expect(pro.tiers.map((tier) => tier.id)).toEqual(['1K', '2K', '4K'])
    expect(pro.surfaces.agent.ratios).toEqual(['1:1', '3:4', '9:16', '4:3', '16:9'])
    expect(pro.surfaces.direct.customSize).toBe(false)
  })

  it('never publishes how the BFF encodes the upstream request', () => {
    const text = JSON.stringify(load())
    expect(text).not.toContain('"wire"')
    expect(text).not.toContain('imageConfig')
    expect(text).not.toContain('upstream-secret.example.com')
    expect(text).not.toContain('sk-test')
  })

  it('leaves models outside the catalog and video models exactly as configured', () => {
    expect(modelOf('not-in-catalog')).toEqual({
      id: 'not-in-catalog',
      label: 'Other',
      capabilities: ['generate'],
    })
    const video = modelOf('grok-imagine-image-2.0')
    expect(video).not.toHaveProperty('image')
    expect(video).not.toHaveProperty('family')
  })

  it('hands out copies, so a caller cannot edit the catalog through the response', () => {
    modelOf('gpt-image-2.5-flare').image!.tiers[0]!.pixels['1:1'] = '1x1'
    expect(findCatalogModel('gpt-image-2.5-flare')!.image.tiers[0]!.pixels['1:1']).toBe('1024x1024')
  })
})

describe('GPT size follows the OpenAI direct switch', () => {
  const saved = { enabled: process.env.GPT_DIRECT_ENABLED, key: process.env.OPENAI_API_KEY }
  afterEach(() => {
    process.env.GPT_DIRECT_ENABLED = saved.enabled
    process.env.OPENAI_API_KEY = saved.key
    if (saved.enabled === undefined) delete process.env.GPT_DIRECT_ENABLED
    if (saved.key === undefined) delete process.env.OPENAI_API_KEY
    _setChannelsForTesting([])
  })

  function flareCapabilities() {
    const { channels } = parseChannelsConfig(
      {
        channels: [
          {
            id: 'gpt',
            kind: 'openai-queue',
            label: 'OpenAI',
            baseUrl: 'https://upstream-secret.example.com/v1',
            auth: { type: 'bearer', secretRef: 'TEST_KEY' },
            models: [
              {
                id: 'gpt-image-2.5-flare',
                label: 'Flare',
                capabilities: ['generate', 'quality', 'size', 'n'],
              },
              { id: 'gpt-image-2', label: 'Other', capabilities: ['generate', 'size'] },
            ],
            defaults: { apiMode: 'images' },
            allowedPaths: ['images/generations'],
          },
        ],
      },
      ENV,
    )
    _setChannelsForTesting(channels)
    const models = getDiscoveredChannels()[0]!.models
    return Object.fromEntries(models.map((model) => [model.id, model.capabilities]))
  }

  it('hides size while direct is off, since sub2api drops it', () => {
    delete process.env.GPT_DIRECT_ENABLED
    process.env.OPENAI_API_KEY = 'sk-real'
    const caps = flareCapabilities()
    expect(caps['gpt-image-2.5-flare']).toEqual(['generate', 'quality', 'n'])
    expect(caps['gpt-image-2']).toEqual(['generate', 'size'])
  })

  it('declares size once direct is on with a key', () => {
    process.env.GPT_DIRECT_ENABLED = 'true'
    process.env.OPENAI_API_KEY = 'sk-real'
    expect(flareCapabilities()['gpt-image-2.5-flare']).toEqual(['generate', 'quality', 'size', 'n'])
  })
})

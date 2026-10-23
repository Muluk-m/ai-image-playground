import type { DiscoveredChannel } from '@image-playground/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { setChannels } from '../../../lib/channels/channelStore'
import { getProfileModelOptions } from '../../../lib/channels/profileSelectors'
import {
  getPublicChannel,
  getPublicChannels,
  modelLabel,
  modelLogo,
} from '../../../lib/channels/publicChannels'
import type { ClientProfile } from '../../../lib/channels/types'
import { GROK_CHANNEL, IMAGE_CHANNEL } from '../../features/video/fixtures'

const MIXED_CHANNEL: DiscoveredChannel = {
  id: 'mixed',
  kind: 'openai-queue',
  label: 'Mixed',
  models: [
    { id: 'img-a', label: 'Image A', capabilities: ['generate'] },
    { id: 'vid-a', label: 'Video A', capabilities: ['generate'], media: 'video' },
    { id: 'img-b', label: 'Image B', capabilities: ['generate'], media: 'image' },
  ],
  defaults: {},
}

function builtinProfile(channelId: string, selectedModelId: string): ClientProfile {
  return { id: channelId, source: 'builtin-edge', channelId, selectedModelId }
}

afterEach(() => {
  setChannels([])
})

describe('getPublicChannels', () => {
  it('drops video models', () => {
    setChannels([MIXED_CHANNEL])

    expect(getPublicChannels()[0].models.map((m) => m.id)).toEqual(['img-a', 'img-b'])
  })

  it('leaves a video-only channel with no models', () => {
    setChannels([IMAGE_CHANNEL, GROK_CHANNEL])

    const grok = getPublicChannels().find((c) => c.id === GROK_CHANNEL.id)
    expect(grok?.models).toEqual([])
    expect(getPublicChannel(GROK_CHANNEL.id)?.models).toEqual([])
  })

  it('keeps image models untouched', () => {
    setChannels([IMAGE_CHANNEL])

    expect(getPublicChannels()).toEqual([IMAGE_CHANNEL])
  })

  it('returns a stable reference until the stored channels change', () => {
    setChannels([MIXED_CHANNEL])
    const first = getPublicChannels()
    expect(getPublicChannels()).toBe(first)

    setChannels([IMAGE_CHANNEL])
    expect(getPublicChannels()).not.toBe(first)
  })

  it('uses the channel label for a known model and keeps an unknown id', () => {
    setChannels([
      {
        id: 'other',
        kind: 'openai-queue',
        label: 'Other',
        models: [{ id: 'shared-model', label: 'Other name', capabilities: ['generate'] }],
        defaults: {},
      },
      {
        id: 'openai-images',
        kind: 'openai-queue',
        label: 'OpenAI',
        models: [
          {
            id: 'gpt-image-2.5-flare',
            label: 'GPT Image 2.5 Flare',
            capabilities: ['generate'],
          },
          { id: 'shared-model', label: 'Preferred name', capabilities: ['generate'] },
        ],
        defaults: {},
      },
    ])

    expect(modelLabel('gpt-image-2.5-flare')).toBe('GPT Image 2.5 Flare')
    expect(modelLabel('shared-model')).toBe('Other name')
    expect(modelLabel('shared-model', 'openai-images')).toBe('Preferred name')
    expect(modelLabel('my-byok-model')).toBe('my-byok-model')
    expect(modelLabel('')).toBe('')
  })

  it('keeps video models out of the image model picker options', () => {
    setChannels([MIXED_CHANNEL])

    expect(getProfileModelOptions(builtinProfile('mixed', 'img-a'), getPublicChannels())).toEqual([
      { id: 'img-a', label: 'Image A' },
      { id: 'img-b', label: 'Image B' },
    ])
  })
})

describe('selector metadata from an unvalidated catalog', () => {
  const STALE: DiscoveredChannel = {
    id: 'stale',
    kind: 'gemini-queue',
    label: 'Stale',
    models: [
      {
        id: 'img-a',
        label: 'Image A',
        capabilities: ['generate'],
        badges: ['fast', 'brand-new', 'fast', 'value'] as never,
        logo: 'future-logo' as never,
      },
      { id: 'img-b', label: 'Image B', capabilities: ['generate'], logo: 'nano-banana' },
    ],
    defaults: {},
  }

  it('keeps only badges the client knows, once each and in order', () => {
    setChannels([STALE])
    const [first] = getProfileModelOptions(builtinProfile('stale', 'img-a'), getPublicChannels())
    expect(first?.badges).toEqual(['fast', 'value'])
  })

  it('gives each selector option the logo its own channel declares', () => {
    const other: DiscoveredChannel = {
      id: 'other',
      kind: 'gemini-queue',
      label: 'Other',
      models: [{ id: 'img-b', label: 'Image B', capabilities: ['generate'] }],
      defaults: {},
    }
    setChannels([STALE, other])
    const fromStale = getProfileModelOptions(builtinProfile('stale', 'img-b'), getPublicChannels())
    const fromOther = getProfileModelOptions(builtinProfile('other', 'img-b'), getPublicChannels())
    expect(fromStale.find((one) => one.id === 'img-b')?.logo).toBe('nano-banana')
    expect(fromOther[0]).not.toHaveProperty('logo')
    // 不认识的 token 不下发给选择器。
    expect(fromStale.find((one) => one.id === 'img-a')).not.toHaveProperty('logo')
  })

  it('ignores a logo token the client has no icon for', () => {
    setChannels([STALE])
    expect(modelLogo('img-a')).toBeUndefined()
    expect(modelLogo('img-b')).toBe('nano-banana')
  })
})

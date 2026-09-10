import type { DiscoveredChannel } from '@image-playground/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { setChannels } from '../../../lib/channels/channelStore'
import { getProfileModelOptions } from '../../../lib/channels/profileSelectors'
import { getPublicChannel, getPublicChannels } from '../../../lib/channels/publicChannels'
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

  it('keeps video models out of the image model picker options', () => {
    setChannels([MIXED_CHANNEL])

    expect(getProfileModelOptions(builtinProfile('mixed', 'img-a'), getPublicChannels())).toEqual([
      { id: 'img-a', label: 'Image A' },
      { id: 'img-b', label: 'Image B' },
    ])
  })
})

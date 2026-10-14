import { describe, expect, it } from 'vitest'
import {
  getProfileModels,
  getSelectedModel,
  isModelKnown,
  modelSupportsNativeMask,
  updateSelectedModel,
} from '../../../lib/channels/profileSelectors'
import type { ClientProfile, PublicChannel } from '../../../lib/channels/types'

const builtinChannel: PublicChannel = {
  id: 'test-channel',
  kind: 'gemini-queue',
  label: 'Test Gemini',
  models: [
    { id: 'gemini-a', label: 'Gemini A', capabilities: ['generate'] },
    { id: 'gemini-b', label: 'Gemini B', capabilities: ['generate'] },
  ],
  defaults: { apiMode: 'images', timeout: 600 },
}

const publicChannels: PublicChannel[] = [builtinChannel]

function makeBuiltin(selectedModelId = 'gemini-a'): ClientProfile {
  return {
    id: 'p1',
    source: 'builtin-edge',
    channelId: 'test-channel',
    selectedModelId,
  }
}

describe('getProfileModels', () => {
  it('reads models from the platform channel', () => {
    expect(getProfileModels(makeBuiltin(), publicChannels)).toEqual(['gemini-a', 'gemini-b'])
  })

  it('returns empty when the channel is gone', () => {
    const profile: ClientProfile = { ...makeBuiltin(), channelId: 'missing' }
    expect(getProfileModels(profile, publicChannels)).toEqual([])
  })
})

describe('getSelectedModel', () => {
  it('returns selectedModelId when valid', () => {
    expect(getSelectedModel(makeBuiltin('gemini-b'), publicChannels)).toBe('gemini-b')
  })

  it('falls back to models[0] when selectedModelId is stale', () => {
    expect(getSelectedModel(makeBuiltin('removed'), publicChannels)).toBe('gemini-a')
  })

  it('returns empty string when no models', () => {
    const profile: ClientProfile = { ...makeBuiltin(), channelId: 'missing' }
    expect(getSelectedModel(profile, publicChannels)).toBe('')
  })
})

describe('updateSelectedModel', () => {
  it('accepts a model on the channel', () => {
    const next = updateSelectedModel(makeBuiltin('gemini-a'), 'gemini-b', publicChannels)
    expect(next.selectedModelId).toBe('gemini-b')
  })

  it('ignores an unknown model', () => {
    const profile = makeBuiltin('gemini-a')
    expect(updateSelectedModel(profile, 'unknown', publicChannels)).toBe(profile)
  })

  it('rejects an empty model id', () => {
    const profile = makeBuiltin()
    expect(updateSelectedModel(profile, '  ', publicChannels)).toBe(profile)
  })
})

describe('modelSupportsNativeMask', () => {
  const maskChannel: PublicChannel = {
    ...builtinChannel,
    id: 'mask-channel',
    models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'mask'] }],
  }

  it('is true only when the model declares mask', () => {
    expect(modelSupportsNativeMask(makeBuiltin(), publicChannels)).toBe(false)
    const masking: ClientProfile = {
      id: 'p1',
      source: 'builtin-edge',
      channelId: 'mask-channel',
      selectedModelId: 'gpt-image-2',
    }
    expect(modelSupportsNativeMask(masking, [maskChannel])).toBe(true)
  })
})

describe('isModelKnown', () => {
  it('recognizes only models currently on the channel', () => {
    expect(isModelKnown(makeBuiltin('gemini-a'), publicChannels)).toBe(true)
    expect(isModelKnown(makeBuiltin('gemini-retired'), publicChannels)).toBe(false)
  })

  it('does not recognize a model whose channel is gone', () => {
    expect(isModelKnown(makeBuiltin(), [])).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  getProfileModels,
  getSelectedModel,
  modelSupportsNativeMask,
  updateProfileModels,
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

function makeByok(models: string[], selectedModelId?: string): ClientProfile {
  return {
    id: 'p2',
    source: 'user-byok',
    name: 'My OpenAI',
    kind: 'openai-compat',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-xxx',
    models,
    selectedModelId: selectedModelId ?? models[0],
    preferences: {
      apiMode: 'images',
      timeout: 600,
      codexCli: false,
      apiProxy: false,
    },
  }
}

describe('getProfileModels', () => {
  it('builtin-edge: from channel.models', () => {
    expect(getProfileModels(makeBuiltin(), publicChannels)).toEqual(['gemini-a', 'gemini-b'])
  })

  it('builtin-edge: unknown channel returns empty', () => {
    const profile: ClientProfile = { ...makeBuiltin(), channelId: 'missing' } as ClientProfile
    expect(getProfileModels(profile, publicChannels)).toEqual([])
  })

  it('user-byok: from profile.models', () => {
    expect(getProfileModels(makeByok(['m1', 'm2']), publicChannels)).toEqual(['m1', 'm2'])
  })
})

describe('getSelectedModel', () => {
  it('returns selectedModelId when valid', () => {
    expect(getSelectedModel(makeBuiltin('gemini-b'), publicChannels)).toBe('gemini-b')
    expect(getSelectedModel(makeByok(['m1', 'm2'], 'm2'), publicChannels)).toBe('m2')
  })

  it('falls back to models[0] when selectedModelId stale', () => {
    expect(getSelectedModel(makeBuiltin('removed'), publicChannels)).toBe('gemini-a')
    expect(getSelectedModel(makeByok(['m1'], 'gone'), publicChannels)).toBe('m1')
  })

  it('returns empty string when no models', () => {
    const p: ClientProfile = { ...makeBuiltin(), channelId: 'missing' } as ClientProfile
    expect(getSelectedModel(p, publicChannels)).toBe('')
  })
})

describe('updateProfileModels', () => {
  it('no-op for builtin-edge', () => {
    const p = makeBuiltin()
    expect(updateProfileModels(p, ['x'])).toBe(p)
  })

  it('BYOK: dedupes, trims empty', () => {
    const next = updateProfileModels(makeByok(['m1']), ['m1', 'm2', 'm2', '', '  '])
    if (next.source !== 'user-byok') throw new Error('expected byok')
    expect(next.models).toEqual(['m1', 'm2'])
  })

  it('BYOK: keeps selectedModelId when still in models', () => {
    const next = updateProfileModels(makeByok(['m1', 'm2'], 'm2'), ['m2', 'm3'])
    if (next.source !== 'user-byok') throw new Error('expected byok')
    expect(next.selectedModelId).toBe('m2')
  })

  it('BYOK: fallback selectedModelId to models[0] when removed', () => {
    const next = updateProfileModels(makeByok(['m1', 'm2'], 'm2'), ['m3', 'm4'])
    if (next.source !== 'user-byok') throw new Error('expected byok')
    expect(next.selectedModelId).toBe('m3')
  })

  it('BYOK: reject empty resulting models (no-op)', () => {
    const p = makeByok(['m1'])
    expect(updateProfileModels(p, ['', '  '])).toBe(p)
  })
})

describe('updateSelectedModel', () => {
  it('builtin-edge: accepts valid channel model', () => {
    const next = updateSelectedModel(makeBuiltin('gemini-a'), 'gemini-b', publicChannels)
    expect(next.selectedModelId).toBe('gemini-b')
  })

  it('builtin-edge: ignores unknown model', () => {
    const p = makeBuiltin('gemini-a')
    expect(updateSelectedModel(p, 'unknown', publicChannels)).toBe(p)
  })

  it('BYOK: existing model just switches selectedModelId', () => {
    const next = updateSelectedModel(makeByok(['m1', 'm2']), 'm2', publicChannels)
    if (next.source !== 'user-byok') throw new Error('expected byok')
    expect(next.selectedModelId).toBe('m2')
    expect(next.models).toEqual(['m1', 'm2'])
  })

  it('BYOK: unknown model auto-appended', () => {
    const next = updateSelectedModel(makeByok(['m1']), 'mx', publicChannels)
    if (next.source !== 'user-byok') throw new Error('expected byok')
    expect(next.models).toEqual(['m1', 'mx'])
    expect(next.selectedModelId).toBe('mx')
  })

  it('rejects empty modelId', () => {
    const p = makeByok(['m1'])
    expect(updateSelectedModel(p, '  ', publicChannels)).toBe(p)
  })
})

describe('modelSupportsNativeMask', () => {
  const maskChannel: PublicChannel = {
    ...builtinChannel,
    id: 'mask-channel',
    models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'mask'] }],
  }

  it('builtin-edge: only when the model declares mask', () => {
    expect(modelSupportsNativeMask(makeBuiltin(), publicChannels)).toBe(false)
    expect(
      modelSupportsNativeMask(
        { ...makeBuiltin(), channelId: 'mask-channel', selectedModelId: 'gpt-image-2' },
        [maskChannel],
      ),
    ).toBe(true)
  })

  it('user-byok: every kind but gemini takes a native mask', () => {
    expect(modelSupportsNativeMask(makeByok(['gpt-image-2']), publicChannels)).toBe(true)
    expect(
      modelSupportsNativeMask(
        { ...makeByok(['g']), kind: 'gemini' } as ClientProfile,
        publicChannels,
      ),
    ).toBe(false)
  })
})

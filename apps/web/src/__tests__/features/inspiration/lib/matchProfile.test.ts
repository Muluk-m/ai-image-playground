import { describe, expect, it } from 'vitest'
import { matchProfile } from '../../../../features/inspiration/lib/matchProfile'
import type { ClientProfile, PublicChannel } from '../../../../lib/channels/types'

const geminiChannel: PublicChannel = {
  id: 'test-gemini',
  kind: 'gemini-queue',
  label: 'Gemini',
  models: [
    { id: 'gemini-3.1-flash-image', label: 'Gemini 3.1', capabilities: ['generate', 'edit'] },
    { id: 'gemini-2.5-flash-image', label: 'Gemini 2.5', capabilities: ['generate'] },
  ],
  defaults: { apiMode: 'images', timeout: 600 },
}

const openaiChannel: PublicChannel = {
  id: 'test-openai',
  kind: 'openai-queue',
  label: 'OpenAI',
  models: [
    { id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare', capabilities: ['generate', 'edit'] },
  ],
  defaults: { apiMode: 'images', timeout: 600 },
}

const publicChannels: PublicChannel[] = [geminiChannel, openaiChannel]

function makeBuiltin(opts: {
  id: string
  channelId: string
  selectedModelId: string
}): ClientProfile {
  return {
    id: opts.id,
    source: 'builtin-edge',
    channelId: opts.channelId,
    selectedModelId: opts.selectedModelId,
  }
}

describe('matchProfile', () => {
  it('returns null when no profile satisfies provider + model', () => {
    const profiles = [
      makeBuiltin({
        id: 'openai',
        channelId: 'test-openai',
        selectedModelId: 'gpt-image-2.5-flare',
      }),
    ]
    const result = matchProfile({
      profiles,
      publicChannels,
      activeProfileId: 'openai',
      provider: 'gemini',
      model: 'gemini-3.1-flash-image',
    })
    expect(result).toBeNull()
  })

  it('prefers the currently active profile when it satisfies the constraint', () => {
    const other = makeBuiltin({
      id: 'other',
      channelId: 'test-gemini',
      selectedModelId: 'gemini-3.1-flash-image',
    })
    const active = makeBuiltin({
      id: 'active',
      channelId: 'test-gemini',
      selectedModelId: 'gemini-3.1-flash-image',
    })
    const result = matchProfile({
      profiles: [other, active],
      publicChannels,
      activeProfileId: 'active',
      provider: 'gemini',
      model: 'gemini-3.1-flash-image',
    })
    expect(result?.profile.id).toBe('active')
  })

  it('falls back to the first matching channel when the active profile cannot serve the model', () => {
    const gemini = makeBuiltin({
      id: 'gemini',
      channelId: 'test-gemini',
      selectedModelId: 'gemini-3.1-flash-image',
    })
    const openai = makeBuiltin({
      id: 'openai',
      channelId: 'test-openai',
      selectedModelId: 'gpt-image-2.5-flare',
    })
    const result = matchProfile({
      profiles: [gemini, openai],
      publicChannels,
      activeProfileId: 'openai',
      provider: 'gemini',
      model: 'gemini-3.1-flash-image',
    })
    expect(result?.profile.id).toBe('gemini')
  })

  it('falls back to the first match when the active profile is unrelated', () => {
    const first = makeBuiltin({
      id: 'first',
      channelId: 'test-gemini',
      selectedModelId: 'gemini-3.1-flash-image',
    })
    const second = makeBuiltin({
      id: 'second',
      channelId: 'test-gemini',
      selectedModelId: 'gemini-3.1-flash-image',
    })
    const result = matchProfile({
      profiles: [first, second],
      publicChannels,
      activeProfileId: 'unrelated',
      provider: 'gemini',
      model: 'gemini-3.1-flash-image',
    })
    expect(result?.profile.id).toBe('first')
  })

  it('skips a channel that does not include the requested model', () => {
    const builtin = makeBuiltin({
      id: 'b1',
      channelId: 'test-gemini',
      selectedModelId: 'gemini-3.1-flash-image',
    })
    const result = matchProfile({
      profiles: [builtin],
      publicChannels,
      activeProfileId: 'b1',
      provider: 'gemini',
      model: 'gemini-7.0-future-model',
    })
    expect(result).toBeNull()
  })

  it('skips a profile with an unknown channelId', () => {
    const builtin = makeBuiltin({ id: 'b1', channelId: 'unknown-channel', selectedModelId: 'x' })
    const result = matchProfile({
      profiles: [builtin],
      publicChannels,
      activeProfileId: 'b1',
      provider: 'gemini',
      model: 'gemini-3.1-flash-image',
    })
    expect(result).toBeNull()
  })

  it('prefers an exact match over a family fallback, even when the fallback is active', () => {
    const legacy: PublicChannel = {
      id: 'test-legacy-openai',
      kind: 'openai-queue',
      label: 'Legacy',
      models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate'] }],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    const activeFallback = makeBuiltin({
      id: 'b-openai',
      channelId: 'test-openai',
      selectedModelId: 'gpt-image-2.5-flare',
    })
    const exact = makeBuiltin({
      id: 'b-legacy',
      channelId: 'test-legacy-openai',
      selectedModelId: 'gpt-image-2',
    })
    const result = matchProfile({
      profiles: [activeFallback, exact],
      publicChannels: [...publicChannels, legacy],
      activeProfileId: 'b-openai',
      provider: 'openai-compat',
      model: 'gpt-image-2',
    })
    expect(result?.profile.id).toBe('b-legacy')
    expect(result?.model).toBe('gpt-image-2')
  })

  it('falls back within the gpt-image family when the exact id is gone', () => {
    const builtin = makeBuiltin({
      id: 'b-openai',
      channelId: 'test-openai',
      selectedModelId: 'gpt-image-2.5-flare',
    })
    const result = matchProfile({
      profiles: [builtin],
      publicChannels,
      activeProfileId: 'none',
      provider: 'openai-compat',
      model: 'gpt-image-2',
    })
    expect(result?.profile.id).toBe('b-openai')
    expect(result?.model).toBe('gpt-image-2.5-flare')
  })

  it('does not fall back across model families', () => {
    const dalle: PublicChannel = {
      id: 'test-dalle',
      kind: 'openai-queue',
      label: 'DALL-E',
      models: [{ id: 'dall-e-3', label: 'DALL-E 3', capabilities: ['generate'] }],
      defaults: { apiMode: 'images', timeout: 600 },
    }
    const builtin = makeBuiltin({
      id: 'b-dalle',
      channelId: 'test-dalle',
      selectedModelId: 'dall-e-3',
    })
    const result = matchProfile({
      profiles: [builtin],
      publicChannels: [...publicChannels, dalle],
      activeProfileId: 'b-dalle',
      provider: 'openai-compat',
      model: 'gpt-image-2',
    })
    expect(result).toBeNull()
  })

  it('does not fall back across providers', () => {
    const gemini = makeBuiltin({
      id: 'gemini',
      channelId: 'test-gemini',
      selectedModelId: 'gemini-3.1-flash-image',
    })
    const result = matchProfile({
      profiles: [gemini],
      publicChannels,
      activeProfileId: 'gemini',
      provider: 'openai-compat',
      model: 'gpt-image-2',
    })
    expect(result).toBeNull()
  })
})

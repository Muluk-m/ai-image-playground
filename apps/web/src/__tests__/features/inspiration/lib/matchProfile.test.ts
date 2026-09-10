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

function makeByok(opts: {
  id: string
  kind: 'openai-compat' | 'gemini'
  models: string[]
}): ClientProfile {
  return {
    id: opts.id,
    source: 'user-byok',
    name: opts.id,
    kind: opts.kind,
    baseUrl: 'https://example.com/v1',
    apiKey: 'sk-x',
    models: opts.models,
    selectedModelId: opts.models[0] ?? '',
    preferences: { apiMode: 'images', timeout: 600, codexCli: false, apiProxy: false },
  }
}

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
    const profiles = [makeByok({ id: 'byok1', kind: 'openai-compat', models: ['gpt-image-2'] })]
    const result = matchProfile({
      profiles,
      publicChannels,
      activeProfileId: 'byok1',
      provider: 'gemini',
      model: 'gemini-3.1-flash-image',
    })
    expect(result).toBeNull()
  })

  it('prefers the currently active profile when it satisfies the constraint', () => {
    const byok1 = makeByok({ id: 'byok1', kind: 'gemini', models: ['gemini-3.1-flash-image'] })
    const builtin = makeBuiltin({
      id: 'b1',
      channelId: 'test-gemini',
      selectedModelId: 'gemini-3.1-flash-image',
    })
    const result = matchProfile({
      profiles: [byok1, builtin],
      publicChannels,
      activeProfileId: 'byok1',
      provider: 'gemini',
      model: 'gemini-3.1-flash-image',
    })
    expect(result?.profile.id).toBe('byok1')
  })

  it('prefers builtin-edge over user-byok when active is unrelated', () => {
    const byok1 = makeByok({ id: 'byok1', kind: 'gemini', models: ['gemini-3.1-flash-image'] })
    const builtin = makeBuiltin({
      id: 'b1',
      channelId: 'test-gemini',
      selectedModelId: 'gemini-3.1-flash-image',
    })
    const openaiByok = makeByok({ id: 'byok2', kind: 'openai-compat', models: ['gpt-image-2'] })
    const result = matchProfile({
      profiles: [byok1, builtin, openaiByok],
      publicChannels,
      activeProfileId: 'byok2', // unrelated active
      provider: 'gemini',
      model: 'gemini-3.1-flash-image',
    })
    expect(result?.profile.id).toBe('b1')
  })

  it('falls back to first match when neither active nor builtin satisfies', () => {
    const byok1 = makeByok({ id: 'byok1', kind: 'gemini', models: ['gemini-3.1-flash-image'] })
    const byok2 = makeByok({ id: 'byok2', kind: 'gemini', models: ['gemini-3.1-flash-image'] })
    const result = matchProfile({
      profiles: [byok1, byok2],
      publicChannels,
      activeProfileId: 'unrelated',
      provider: 'gemini',
      model: 'gemini-3.1-flash-image',
    })
    expect(result?.profile.id).toBe('byok1')
  })

  it('skips builtin-edge whose channel does not include the requested model', () => {
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

  it('skips builtin-edge with unknown channelId', () => {
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
    const byok = makeByok({ id: 'byok1', kind: 'openai-compat', models: ['gpt-image-2.5-flare'] })
    const builtin = makeBuiltin({
      id: 'b-openai',
      channelId: 'test-openai',
      selectedModelId: 'gpt-image-2.5-flare',
    })
    const result = matchProfile({
      profiles: [byok, builtin],
      publicChannels,
      activeProfileId: 'none',
      provider: 'openai-compat',
      model: 'gpt-image-2',
    })
    // builtin-edge 的优先级在回退档里同样成立
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
    const geminiByok = makeByok({ id: 'byok1', kind: 'gemini', models: ['gpt-image-2.5-flare'] })
    const result = matchProfile({
      profiles: [geminiByok],
      publicChannels,
      activeProfileId: 'byok1',
      provider: 'openai-compat',
      model: 'gpt-image-2',
    })
    expect(result).toBeNull()
  })
})

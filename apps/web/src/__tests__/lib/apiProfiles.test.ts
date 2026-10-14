import { describe, expect, it } from 'vitest'
import {
  clientProfileToApiProfile,
  createBuiltinEdgeProfile,
  DEFAULT_SETTINGS,
  getActiveApiProfile,
  getApiProviderLabel,
  mergeImportedSettings,
  normalizeApiTimeout,
  normalizeClientProfile,
  normalizeSettings,
  validateClientProfile,
} from '../../lib/apiProfiles'
import { resetChannelCatalog, setChannels } from '../../lib/channels/channelStore'
import type { PublicChannel } from '../../lib/channels/types'

const CHANNEL: PublicChannel = {
  id: 'openai-images',
  kind: 'openai-queue',
  label: 'OpenAI',
  models: [
    { id: 'gpt-image-2.5-flare', label: 'Flare', capabilities: ['generate'] },
    { id: 'gpt-image-2.5-sunburst', label: 'Sunburst', capabilities: ['generate'] },
  ],
  defaults: { apiMode: 'images', timeout: 600 },
}

describe('normalizeApiTimeout', () => {
  it('rejects non-positive and non-finite values', () => {
    expect(normalizeApiTimeout(0)).toBe(600)
    expect(normalizeApiTimeout(-1)).toBe(600)
    expect(normalizeApiTimeout(Number.NaN)).toBe(600)
    expect(normalizeApiTimeout('30')).toBe(600)
    expect(normalizeApiTimeout(30)).toBe(30)
  })
})

describe('normalizeClientProfile', () => {
  it('keeps a platform channel profile', () => {
    expect(
      normalizeClientProfile(createBuiltinEdgeProfile('openai-images', 'gpt-image-2')),
    ).toEqual(createBuiltinEdgeProfile('openai-images', 'gpt-image-2'))
  })

  it('drops a stored bring-your-own-key profile', () => {
    expect(
      normalizeClientProfile({
        id: 'default-openai',
        source: 'user-byok',
        name: '默认',
        kind: 'openai-compat',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-old',
        models: ['gpt-image-2'],
        selectedModelId: 'gpt-image-2',
        preferences: { apiMode: 'images', timeout: 600, codexCli: false, apiProxy: false },
      }),
    ).toBeNull()
  })
})

describe('normalizeSettings migration', () => {
  it('lands on the first platform channel when the saved profile was bring-your-own-key', () => {
    setChannels([CHANNEL])
    try {
      const settings = normalizeSettings({
        profiles: [
          {
            id: 'default-openai',
            source: 'user-byok',
            name: '默认',
            kind: 'openai-compat',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: '',
            models: ['gpt-image-2'],
            selectedModelId: 'gpt-image-2',
            preferences: { apiMode: 'images', timeout: 600, codexCli: false, apiProxy: true },
          },
        ],
        activeProfileId: 'default-openai',
        customProviders: [{ id: 'custom', name: 'Old' }],
        clearInputAfterSubmit: true,
      })
      expect(settings.profiles).toEqual([
        createBuiltinEdgeProfile('openai-images', 'gpt-image-2.5-flare'),
      ])
      expect(settings.activeProfileId).toBe('openai-images')
      expect(settings.clearInputAfterSubmit).toBe(true)
      expect(settings).not.toHaveProperty('customProviders')
      expect(clientProfileToApiProfile(getActiveApiProfile(settings)).apiKey).toBe('')
    } finally {
      setChannels([])
    }
  })

  it('keeps a still-valid platform model selection and ignores a retired one', () => {
    setChannels([CHANNEL])
    try {
      const kept = normalizeSettings({
        profiles: [createBuiltinEdgeProfile('openai-images', 'gpt-image-2.5-sunburst')],
        activeProfileId: 'openai-images',
      })
      expect(kept.profiles[0]?.selectedModelId).toBe('gpt-image-2.5-sunburst')

      const retired = normalizeSettings({
        profiles: [createBuiltinEdgeProfile('openai-images', 'gpt-image-2')],
        activeProfileId: 'openai-images',
      })
      expect(retired.profiles[0]?.selectedModelId).toBe('gpt-image-2.5-flare')
    } finally {
      setChannels([])
    }
  })

  it('stays empty until channels load, without inventing a keyless profile', () => {
    setChannels([])
    const settings = normalizeSettings({
      profiles: [
        {
          source: 'user-byok',
          apiKey: '',
          baseUrl: 'https://api.openai.com/v1',
          selectedModelId: 'gpt-image-2',
        },
      ],
      activeProfileId: 'default-openai',
    })
    expect(settings.profiles).toEqual([])
    expect(settings.activeProfileId).toBe('')
    expect(getActiveApiProfile(settings).channelId).toBe('')
    expect(validateClientProfile(getActiveApiProfile(settings))).toMatch(/模型/)
  })

  it('keeps a saved platform model until the catalog settles, then validates it', () => {
    resetChannelCatalog()
    const saved = createBuiltinEdgeProfile('openai-images', 'gpt-image-2.5-sunburst')
    const pending = normalizeSettings({ profiles: [saved], activeProfileId: saved.id })
    expect(pending.profiles).toEqual([saved])
    expect(pending.activeProfileId).toBe(saved.id)

    setChannels([CHANNEL])
    try {
      const ready = normalizeSettings(pending)
      expect(ready.profiles[0]?.selectedModelId).toBe('gpt-image-2.5-sunburst')

      setChannels([{ ...CHANNEL, models: [CHANNEL.models[0]!] }])
      const dropped = normalizeSettings(ready)
      expect(dropped.profiles[0]?.selectedModelId).toBe('gpt-image-2.5-flare')
    } finally {
      setChannels([])
    }
  })

  it('recomputes after a settled empty catalog gains channels', () => {
    setChannels([])
    const hydrated = normalizeSettings({
      profiles: [createBuiltinEdgeProfile('openai-images', 'gpt-image-2.5-sunburst')],
    })
    expect(hydrated.profiles).toEqual([])
    setChannels([CHANNEL])
    try {
      const next = normalizeSettings(hydrated)
      expect(next.profiles[0]?.selectedModelId).toBe('gpt-image-2.5-flare')
    } finally {
      setChannels([])
    }
  })
})

describe('mergeImportedSettings', () => {
  it('keeps usage preferences and drops imported profiles and keys', () => {
    setChannels([CHANNEL])
    try {
      const merged = mergeImportedSettings(DEFAULT_SETTINGS, {
        enterSubmit: false,
        profiles: [
          {
            source: 'user-byok',
            apiKey: 'sk-imported',
            baseUrl: 'https://evil.example/v1',
            selectedModelId: 'gpt-image-2',
          },
        ],
        activeProfileId: 'imported',
        customProviders: [{ id: 'x' }],
      })
      expect(merged.enterSubmit).toBe(false)
      expect(merged.activeProfileId).toBe('openai-images')
      expect(merged.profiles.every((profile) => profile.source === 'builtin-edge')).toBe(true)
      expect(JSON.stringify(merged)).not.toContain('sk-imported')
    } finally {
      setChannels([])
    }
  })
})

describe('getApiProviderLabel', () => {
  it('labels the platform protocol families', () => {
    expect(getApiProviderLabel(DEFAULT_SETTINGS, 'openai')).toBe('OpenAI')
    expect(getApiProviderLabel(DEFAULT_SETTINGS, 'openai-compat')).toBe('OpenAI')
    expect(getApiProviderLabel(DEFAULT_SETTINGS, 'gemini')).toBe('Gemini')
    expect(getApiProviderLabel(DEFAULT_SETTINGS, 'gemini-queue')).toBe('Gemini')
  })
})

describe('validateClientProfile', () => {
  it('accepts a platform profile that has a model', () => {
    expect(
      validateClientProfile(createBuiltinEdgeProfile('openai-images', 'gpt-image-2')),
    ).toBeNull()
  })
})

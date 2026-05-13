import { describe, expect, it } from 'vitest'
import {
  createDefaultGeminiByokProfile,
  createDefaultOpenAIByokProfile,
  DEFAULT_IMAGES_MODEL,
  DEFAULT_SETTINGS,
  normalizeSettings,
} from './apiProfiles'
import { buildSettingsFromUrlParams, clearUrlSettingParams, hasUrlSettingParams } from './urlSettings'

function asByok(profile: ReturnType<typeof normalizeSettings>['profiles'][number]) {
  if (profile.source !== 'user-byok') throw new Error('expected user-byok profile')
  return profile
}

describe('URL settings params', () => {
  it('creates and activates a new user-byok profile for legacy URL params', () => {
    const current = normalizeSettings(DEFAULT_SETTINGS)
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('apiUrl=https://api.example.com/v1&apiKey=test-key')),
    })

    expect(next.profiles).toHaveLength(2)
    expect(next.activeProfileId).not.toBe(current.activeProfileId)
    const active = asByok(next.profiles.find((p) => p.id === next.activeProfileId)!)
    expect(active.name).toBe('URL 参数配置')
    expect(active.kind).toBe('openai-compat')
    expect(active.baseUrl).toBe('https://api.example.com/v1')
    expect(active.apiKey).toBe('test-key')
    expect(active.selectedModelId).toBe(DEFAULT_IMAGES_MODEL)
  })

  it('uses model from URL params', () => {
    const current = normalizeSettings(DEFAULT_SETTINGS)
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('apiUrl=https://api.example.com/v1&apiKey=test-key&model=custom-image-model')),
    })

    const active = asByok(next.profiles.find((p) => p.id === next.activeProfileId)!)
    expect(active.kind).toBe('openai-compat')
    expect(active.baseUrl).toBe('https://api.example.com/v1')
    expect(active.apiKey).toBe('test-key')
    expect(active.selectedModelId).toBe('custom-image-model')
    expect(active.preferences.apiMode).toBe('images')
  })

  it('does not create a duplicate profile for matching legacy URL params', () => {
    const existingProfile = createDefaultOpenAIByokProfile({
      id: 'existing-openai',
      name: 'Existing OpenAI',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
    })
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [createDefaultOpenAIByokProfile(), existingProfile],
      activeProfileId: DEFAULT_SETTINGS.activeProfileId,
    })
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('apiUrl=https://api.example.com/v1/&apiKey=test-key')),
    })

    expect(next.profiles).toHaveLength(2)
    expect(next.activeProfileId).toBe(existingProfile.id)
  })

  it('creates an openai-compat profile from legacy params even when a gemini profile is active', () => {
    const geminiProfile = createDefaultGeminiByokProfile({ id: 'gemini-active', apiKey: 'gemini-key' })
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [geminiProfile],
      activeProfileId: geminiProfile.id,
    })
    const next = normalizeSettings({
      ...current,
      ...buildSettingsFromUrlParams(current, new URLSearchParams('apiUrl=https://api.example.com/v1&apiKey=openai-key')),
    })

    expect(next.profiles).toHaveLength(2)
    const active = asByok(next.profiles.find((p) => p.id === next.activeProfileId)!)
    expect(active.kind).toBe('openai-compat')
    expect(active.baseUrl).toBe('https://api.example.com/v1')
    expect(active.apiKey).toBe('openai-key')
  })

  it('clears known URL setting params without touching unrelated params', () => {
    const params = new URLSearchParams('apiUrl=https://api.example.com/v1&apiKey=test-key&model=test-model&foo=bar')

    expect(hasUrlSettingParams(params)).toBe(true)
    clearUrlSettingParams(params)

    expect(params.toString()).toBe('foo=bar')
  })

  it('imports custom providers + profiles wrapper from URL settings param', () => {
    const importedSettings = {
      customProviders: [{
        id: 'custom-json',
        name: 'Custom JSON',
        submit: {
          path: 'images/generations',
          method: 'POST',
          contentType: 'json',
          body: { model: '$profile.model', prompt: '$prompt' },
          result: { imageUrlPaths: ['data.*.url'], b64JsonPaths: [] },
        },
      }],
      // 新形态：profile 用 user-byok shape；以 kind='openai-compat' 表达旧 custom-json provider 的行为
      profiles: [{
        id: 'custom-profile',
        source: 'user-byok',
        name: 'Custom Profile',
        kind: 'openai-compat',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'custom-key',
        models: ['custom-model'],
        selectedModelId: 'custom-model',
        preferences: { apiMode: 'images', timeout: 300, codexCli: false, apiProxy: false },
      }],
    }
    const params = new URLSearchParams()
    params.set('settings', JSON.stringify(importedSettings))

    const next = normalizeSettings({
      ...DEFAULT_SETTINGS,
      ...buildSettingsFromUrlParams(DEFAULT_SETTINGS, params),
    })

    expect(next.customProviders).toHaveLength(1)
    expect(next.customProviders[0]).toMatchObject({ id: 'custom-json', name: 'Custom JSON' })
    expect(next.activeProfileId).toBe('custom-profile')
    const active = asByok(next.profiles[0])
    expect(active.kind).toBe('openai-compat')
    expect(active.apiKey).toBe('custom-key')
    expect(active.selectedModelId).toBe('custom-model')
  })
})

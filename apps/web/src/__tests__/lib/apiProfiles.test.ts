import { describe, expect, it } from 'vitest'
import {
  apiProfileToClientProfile,
  clientProfileToApiProfile,
  createBuiltinEdgeProfile,
  createDefaultGeminiByokProfile,
  createDefaultOpenAIByokProfile,
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_IMAGES_MODEL,
  DEFAULT_OPENAI_PROFILE_ID,
  DEFAULT_SETTINGS,
  findEquivalentClientProfile,
  getApiProviderLabel,
  importCustomProviderDefinitionFromJson,
  importCustomProviderSettingsFromJson,
  isBuiltinProfile,
  mergeImportedSettings,
  normalizeClientProfile,
  normalizeSettings,
  switchByokProfileKind,
  validateClientProfile,
} from '../../lib/apiProfiles'
import type { UserByokProfile } from '../../lib/channels/types'

describe('createDefaultOpenAIByokProfile', () => {
  it('returns an openai-compat user-byok profile with defaults', () => {
    const p = createDefaultOpenAIByokProfile()
    expect(p.source).toBe('user-byok')
    expect(p.kind).toBe('openai-compat')
    expect(p.id).toBe(DEFAULT_OPENAI_PROFILE_ID)
    expect(p.models).toEqual([DEFAULT_IMAGES_MODEL])
    expect(p.selectedModelId).toBe(DEFAULT_IMAGES_MODEL)
    expect(p.preferences.apiMode).toBe('images')
  })
})

describe('createDefaultGeminiByokProfile', () => {
  it('returns a gemini user-byok profile with v1beta defaults', () => {
    const p = createDefaultGeminiByokProfile()
    expect(p.source).toBe('user-byok')
    expect(p.kind).toBe('gemini')
    expect(p.baseUrl).toBe(DEFAULT_GEMINI_BASE_URL)
    expect(p.models).toEqual([DEFAULT_GEMINI_MODEL])
    expect(p.selectedModelId).toBe(DEFAULT_GEMINI_MODEL)
    expect(p.preferences.apiProxy).toBe(false)
    expect(p.preferences.codexCli).toBe(false)
  })
})

describe('normalizeClientProfile', () => {
  it('normalizes a builtin-edge profile preserving channelId + selectedModelId', () => {
    const p = normalizeClientProfile({
      source: 'builtin-edge',
      id: 'test-x',
      channelId: 'test-x',
      selectedModelId: 'model-a',
    })
    expect(p).toEqual({
      id: 'test-x',
      source: 'builtin-edge',
      channelId: 'test-x',
      selectedModelId: 'model-a',
    })
  })

  it('rejects builtin-edge profile missing channelId', () => {
    expect(normalizeClientProfile({ source: 'builtin-edge', selectedModelId: 'm' })).toBeNull()
  })

  it('normalizes user-byok profile, defaulting models from kind', () => {
    const p = normalizeClientProfile({
      source: 'user-byok',
      id: 'b1',
      name: 'B',
      kind: 'gemini',
      baseUrl: '',
      apiKey: 'k',
    }) as UserByokProfile
    expect(p?.source).toBe('user-byok')
    expect(p.kind).toBe('gemini')
    expect(p.baseUrl).toBe(DEFAULT_GEMINI_BASE_URL)
    expect(p.models).toEqual([DEFAULT_GEMINI_MODEL])
    expect(p.selectedModelId).toBe(DEFAULT_GEMINI_MODEL)
  })

  it('falls back selectedModelId to models[0] when out of range', () => {
    const p = normalizeClientProfile({
      source: 'user-byok',
      id: 'b1',
      name: 'B',
      kind: 'openai-compat',
      models: ['m1', 'm2'],
      selectedModelId: 'unknown',
    }) as UserByokProfile
    expect(p.selectedModelId).toBe('m1')
  })

  it('drops unrecognized source', () => {
    expect(normalizeClientProfile({ source: 'unknown', id: 'x' })).toBeNull()
  })
})

describe('isBuiltinProfile', () => {
  it('returns true for builtin-edge source', () => {
    expect(isBuiltinProfile(createBuiltinEdgeProfile('test-x', 'm'))).toBe(true)
  })
  it('returns false for user-byok source', () => {
    expect(isBuiltinProfile(createDefaultOpenAIByokProfile())).toBe(false)
    expect(isBuiltinProfile(null)).toBe(false)
    expect(isBuiltinProfile(undefined)).toBe(false)
  })
})

describe('normalizeSettings', () => {
  it('returns default openai byok profile when input is empty', () => {
    const s = normalizeSettings({})
    expect(s.profiles).toHaveLength(1)
    expect(s.profiles[0].source).toBe('user-byok')
    expect(s.activeProfileId).toBe(DEFAULT_OPENAI_PROFILE_ID)
  })

  it('preserves user-byok profiles from input', () => {
    const byok = createDefaultGeminiByokProfile({ id: 'g1', name: 'G', apiKey: 'k' })
    const s = normalizeSettings({ profiles: [byok], activeProfileId: 'g1' })
    expect(s.profiles).toHaveLength(1)
    expect(s.profiles[0].id).toBe('g1')
    expect(s.activeProfileId).toBe('g1')
  })

  it('drops invalid profile records', () => {
    const s = normalizeSettings({ profiles: [{ source: 'unknown' }, { source: 'builtin-edge' }] })
    expect(s.profiles).toHaveLength(1)
    expect(s.profiles[0].source).toBe('user-byok')
  })

  it('falls back activeProfileId to first profile if invalid', () => {
    const byok = createDefaultOpenAIByokProfile({ id: 'p1' })
    const s = normalizeSettings({ profiles: [byok], activeProfileId: 'nonexistent' })
    expect(s.activeProfileId).toBe('p1')
  })
})

describe('switchByokProfileKind', () => {
  it('switches openai → gemini using gemini defaults', () => {
    const base = createDefaultOpenAIByokProfile({
      apiKey: 'sk-abc',
      baseUrl: 'https://api.openai.com/v1',
    })
    const next = switchByokProfileKind(base, 'gemini')
    expect(next.kind).toBe('gemini')
    expect(next.baseUrl).toBe(DEFAULT_GEMINI_BASE_URL)
    expect(next.selectedModelId).toBe(DEFAULT_GEMINI_MODEL)
    expect(next.apiKey).toBe('sk-abc')
    expect(next.preferences.codexCli).toBe(false)
    expect(next.preferences.apiProxy).toBe(false)
  })

  it('no-op if kind is unchanged', () => {
    const base = createDefaultOpenAIByokProfile()
    const next = switchByokProfileKind(base, 'openai-compat')
    expect(next).toBe(base)
  })
})

describe('validateClientProfile', () => {
  it('returns error for byok missing apiKey', () => {
    expect(validateClientProfile(createDefaultOpenAIByokProfile())).toMatch(/API Key/)
  })
  it('returns null for fully populated byok', () => {
    expect(validateClientProfile(createDefaultOpenAIByokProfile({ apiKey: 'k' }))).toBeNull()
  })
  it('returns null for builtin-edge profile with selectedModelId', () => {
    expect(validateClientProfile(createBuiltinEdgeProfile('test-x', 'm'))).toBeNull()
  })
})

describe('findEquivalentClientProfile', () => {
  it('matches user-byok by all key fields', () => {
    const p = createDefaultGeminiByokProfile({ id: 'g1', apiKey: 'k' })
    const settings = normalizeSettings({ profiles: [p], activeProfileId: 'g1' })
    const same = createDefaultGeminiByokProfile({ id: 'other', apiKey: 'k' })
    const found = findEquivalentClientProfile(settings, same)
    expect(found?.id).toBe('g1')
  })

  it('matches keyless candidate to keyed existing by connection key', () => {
    const stored = createDefaultGeminiByokProfile({ id: 'g1', apiKey: 'sk' })
    const settings = normalizeSettings({ profiles: [stored], activeProfileId: 'g1' })
    const candidate = createDefaultGeminiByokProfile({ id: 'imp', apiKey: '' })
    const found = findEquivalentClientProfile(settings, candidate)
    expect(found?.id).toBe('g1')
  })

  it('does not match builtin-edge to user-byok', () => {
    const byok = createDefaultGeminiByokProfile({ id: 'g1', apiKey: 'k' })
    const settings = normalizeSettings({ profiles: [byok], activeProfileId: 'g1' })
    const edge = createBuiltinEdgeProfile('test-x', 'm')
    expect(findEquivalentClientProfile(settings, edge)).toBeNull()
  })
})

describe('mergeImportedSettings', () => {
  it('replaces untouched default with imported settings', () => {
    const importedByok = createDefaultGeminiByokProfile({ id: 'imp-g', name: 'Imp', apiKey: 'k' })
    const merged = mergeImportedSettings(DEFAULT_SETTINGS, {
      profiles: [importedByok],
      activeProfileId: 'imp-g',
    })
    expect(merged.profiles).toHaveLength(1)
    expect(merged.profiles[0].id).toBe('imp-g')
  })

  it('appends new byok profiles when current is customized', () => {
    const current = normalizeSettings({
      profiles: [createDefaultOpenAIByokProfile({ id: 'p1', apiKey: 'sk-current' })],
      activeProfileId: 'p1',
    })
    const importedByok = createDefaultGeminiByokProfile({
      id: 'imp-g',
      name: 'Imp',
      apiKey: 'sk-imp',
    })
    const merged = mergeImportedSettings(current, { profiles: [importedByok] })
    expect(merged.profiles).toHaveLength(2)
    const byIds = merged.profiles.map((p) => p.id).sort()
    expect(byIds).toContain('p1')
  })

  it('deduplicates imported byok against existing same connection', () => {
    const current = normalizeSettings({
      profiles: [
        createDefaultOpenAIByokProfile({ id: 'p1', apiKey: 'sk', baseUrl: 'https://x.example/v1' }),
      ],
      activeProfileId: 'p1',
    })
    const duplicate = createDefaultOpenAIByokProfile({
      id: 'p2',
      apiKey: 'sk',
      baseUrl: 'https://x.example/v1',
    })
    const merged = mergeImportedSettings(current, { profiles: [duplicate] })
    expect(merged.profiles).toHaveLength(1)
    expect(merged.profiles[0].id).toBe('p1')
  })
})

describe('clientProfileToApiProfile / apiProfileToClientProfile', () => {
  it('round-trips user-byok preserving fields', () => {
    const byok = createDefaultGeminiByokProfile({ id: 'g1', name: 'G', apiKey: 'k' })
    const api = clientProfileToApiProfile(byok)
    expect(api.provider).toBe('gemini')
    expect(api.apiKey).toBe('k')
    expect(api.model).toBe(DEFAULT_GEMINI_MODEL)
    const back = apiProfileToClientProfile(api)
    expect(back.source).toBe('user-byok')
    if (back.source === 'user-byok') {
      expect(back.kind).toBe('gemini')
      expect(back.selectedModelId).toBe(DEFAULT_GEMINI_MODEL)
    }
  })
})

describe('getApiProviderLabel', () => {
  it('returns OpenAI / Gemini labels', () => {
    expect(getApiProviderLabel(DEFAULT_SETTINGS, 'openai')).toBe('OpenAI')
    expect(getApiProviderLabel(DEFAULT_SETTINGS, 'openai-compat')).toBe('OpenAI')
    expect(getApiProviderLabel(DEFAULT_SETTINGS, 'gemini')).toBe('Gemini')
  })
})

describe('custom provider import (data shape only)', () => {
  it('imports a wrapped customProviders + profiles payload', () => {
    const result = importCustomProviderSettingsFromJson(
      JSON.stringify({
        customProviders: [
          {
            id: 'custom-json',
            name: 'Custom JSON',
            submit: {
              path: 'images/generations',
              method: 'POST',
              contentType: 'json',
              body: { model: '$profile.model', prompt: '$prompt' },
              result: { imageUrlPaths: ['data.*.url'], b64JsonPaths: [] },
            },
          },
        ],
        profiles: [
          {
            // 旧 ApiProfile shape — 由 import 路径迁移成 user-byok
            name: 'Custom JSON',
            provider: 'custom-json',
            baseUrl: 'https://custom.example.com/v1',
            model: 'custom-model',
            apiMode: 'images',
          },
        ],
      }),
    )
    expect(result.customProviders).toHaveLength(1)
    expect(result.profiles).toHaveLength(1)
    expect(result.profiles[0].source).toBe('user-byok')
  })

  it('imports a single custom provider manifest', () => {
    const p = importCustomProviderDefinitionFromJson(
      JSON.stringify({
        name: 'Apimart GPT-Image-2',
        template: 'http-image',
        submit: {
          path: '/v1/images/generations',
          method: 'POST',
          contentType: 'json',
          body: { model: '$profile.model', prompt: '$prompt' },
          taskIdPath: 'data.0.task_id',
        },
      }),
    )
    expect(p.template).toBe('http-image')
    expect(p.submit.path).toBe('images/generations')
  })
})

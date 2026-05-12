import { describe, expect, it } from 'vitest'
import type { ClientProfile, PublicChannel } from './types'
import { LEGACY_BUILTIN_ID_MAP, migrateLegacyProfiles, stripLegacyFalFields } from './migration'

const channels: PublicChannel[] = [
  {
    id: 'qlj-sub2api-gemini-flash-image',
    kind: 'gemini',
    label: 'qlj · Gemini 3.1 Flash Image',
    models: [{ id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image' }],
    defaults: { apiMode: 'images', timeout: 600 },
  },
  {
    id: 'qlj-openai-gpt-image',
    kind: 'openai-compat',
    label: 'qlj · OpenAI gpt-image',
    models: [
      { id: 'gpt-image-2', label: 'GPT Image 2' },
      { id: 'gpt-image-2-2026-04-21', label: 'GPT Image 2 (2026-04-21)' },
    ],
    defaults: { apiMode: 'images', timeout: 600 },
  },
]

describe('migrateLegacyProfiles', () => {
  it('drops fal profiles', () => {
    const result = migrateLegacyProfiles(
      { profiles: [{ id: 'p1', provider: 'fal', apiKey: 'k', model: 'm' }] },
      channels,
    )
    expect(result.profiles).toHaveLength(0)
    expect(result.droppedLegacyIds).toEqual(['p1'])
  })

  it('maps legacy builtin id to new channelId', () => {
    const result = migrateLegacyProfiles(
      {
        profiles: [
          {
            id: 'builtin-sub2api-gemini',
            provider: 'gemini',
            apiKey: 'leaked-key',
            model: 'gemini-3.1-flash-image',
          },
        ],
      },
      channels,
    )
    expect(result.profiles).toHaveLength(1)
    const p = result.profiles[0]
    expect(p.source).toBe('builtin-edge')
    if (p.source !== 'builtin-edge') throw new Error('unreachable')
    expect(p.channelId).toBe('qlj-sub2api-gemini-flash-image')
    expect(p.selectedModelId).toBe('gemini-3.1-flash-image')
    expect((p as unknown as { apiKey?: string }).apiKey).toBeUndefined()
  })

  it('drops legacy builtin with unknown id', () => {
    const result = migrateLegacyProfiles(
      { profiles: [{ id: 'builtin-unknown', provider: 'openai', model: 'gpt-image-2' }] },
      channels,
    )
    expect(result.profiles).toHaveLength(0)
    expect(result.droppedLegacyIds).toEqual(['builtin-unknown'])
  })

  it('absorbs builtinProfileModelSelections into builtin-edge selectedModelId', () => {
    const result = migrateLegacyProfiles(
      {
        profiles: [{ id: 'builtin-sub2api-gemini', provider: 'gemini', model: 'gemini-3.1-flash-image' }],
        builtinProfileModelSelections: { 'builtin-sub2api-gemini': 'gemini-3.1-flash-image' },
      },
      channels,
    )
    expect(result.consumedBuiltinModelSelections).toBe(true)
    const p = result.profiles[0]
    if (p.source !== 'builtin-edge') throw new Error('unreachable')
    expect(p.selectedModelId).toBe('gemini-3.1-flash-image')
  })

  it('BYOK: model + models merged and deduped', () => {
    const result = migrateLegacyProfiles(
      {
        profiles: [
          {
            id: 'u1',
            name: 'my-openai',
            provider: 'openai',
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'sk-xxx',
            model: 'gpt-image-2',
            models: ['gpt-image-2', 'gpt-image-1'],
            apiMode: 'images',
            timeout: 600,
            codexCli: false,
            apiProxy: false,
          },
        ],
      },
      channels,
    )
    const p = result.profiles[0]
    if (p.source !== 'user-byok') throw new Error('unreachable')
    expect(p.kind).toBe('openai-compat')
    expect(p.models).toEqual(['gpt-image-2', 'gpt-image-1'])
    expect(p.selectedModelId).toBe('gpt-image-2')
    expect(p.preferences).toEqual({
      apiMode: 'images',
      timeout: 600,
      codexCli: false,
      apiProxy: false,
      responseFormatB64Json: undefined,
    })
  })

  it('BYOK: empty model → default by kind', () => {
    const openaiResult = migrateLegacyProfiles(
      { profiles: [{ id: 'u2', provider: 'openai', apiKey: 'sk' }] },
      channels,
    )
    const op = openaiResult.profiles[0]
    if (op.source !== 'user-byok') throw new Error('unreachable')
    expect(op.models).toEqual(['gpt-image-2'])
    expect(op.selectedModelId).toBe('gpt-image-2')

    const geminiResult = migrateLegacyProfiles(
      { profiles: [{ id: 'u3', provider: 'gemini', apiKey: 'sk' }] },
      channels,
    )
    const gp = geminiResult.profiles[0]
    if (gp.source !== 'user-byok') throw new Error('unreachable')
    expect(gp.models).toEqual(['gemini-3.1-flash-image'])
  })

  it('BYOK: model not in models gets prepended', () => {
    const result = migrateLegacyProfiles(
      { profiles: [{ id: 'u4', provider: 'openai', apiKey: 'sk', model: 'ft:custom', models: ['gpt-image-2'] }] },
      channels,
    )
    const p = result.profiles[0]
    if (p.source !== 'user-byok') throw new Error('unreachable')
    expect(p.models).toEqual(['ft:custom', 'gpt-image-2'])
    expect(p.selectedModelId).toBe('ft:custom')
  })

  it('custom-xxx provider becomes openai-compat kind', () => {
    const result = migrateLegacyProfiles(
      { profiles: [{ id: 'u5', provider: 'custom-foo', apiKey: 'sk', model: 'foo-model' }] },
      channels,
    )
    const p = result.profiles[0]
    if (p.source !== 'user-byok') throw new Error('unreachable')
    expect(p.kind).toBe('openai-compat')
    expect(p.models).toEqual(['foo-model'])
  })

  it('activeProfileId falls back when target dropped', () => {
    const result = migrateLegacyProfiles(
      {
        profiles: [
          { id: 'fal-1', provider: 'fal' },
          { id: 'u1', provider: 'openai', apiKey: 'sk', model: 'gpt-image-2' },
        ],
        activeProfileId: 'fal-1',
      },
      channels,
    )
    expect(result.profiles).toHaveLength(1)
    expect(result.activeProfileId).toBe('u1')
  })

  it('idempotent: ClientProfile passthrough', () => {
    const existing: ClientProfile = {
      id: 'existing',
      source: 'builtin-edge',
      channelId: 'qlj-sub2api-gemini-flash-image',
      selectedModelId: 'gemini-3.1-flash-image',
    }
    const result = migrateLegacyProfiles({ profiles: [existing], activeProfileId: 'existing' }, channels)
    expect(result.profiles[0]).toEqual(existing)
    expect(result.activeProfileId).toBe('existing')
    expect(result.droppedLegacyIds).toEqual([])
  })

  it('unknown provider dropped', () => {
    const result = migrateLegacyProfiles(
      { profiles: [{ id: 'bad', provider: 'unknown', apiKey: 'sk' }] },
      channels,
    )
    expect(result.profiles).toHaveLength(0)
    expect(result.droppedLegacyIds).toEqual(['bad'])
  })

  it('exports LEGACY_BUILTIN_ID_MAP for documentation', () => {
    expect(LEGACY_BUILTIN_ID_MAP['builtin-sub2api-gemini']).toBe('qlj-sub2api-gemini-flash-image')
  })
})

describe('stripLegacyFalFields', () => {
  it('removes fal fields, keeps others', () => {
    const out = stripLegacyFalFields({
      id: 't1',
      prompt: 'p',
      falRequestId: 'r',
      falEndpoint: 'e',
      falRecoverable: true,
      kept: 'yes',
    } as Record<string, unknown>)
    expect(out).toEqual({ id: 't1', prompt: 'p', kept: 'yes' })
  })
})

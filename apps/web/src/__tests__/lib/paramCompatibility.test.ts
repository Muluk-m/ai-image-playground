import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, getActiveApiProfile, normalizeSettings } from '../../lib/apiProfiles'
import type {
  ClientProfile,
  PublicChannel,
  UserByokPreferences,
  UserByokProfile,
} from '../../lib/channels/types'
import {
  getOutputImageLimitForSettings,
  getParamCapabilities,
  normalizeParamsForSettings,
} from '../../lib/paramCompatibility'
import { type AppSettings, DEFAULT_PARAMS } from '../../types'

const mockChannels = vi.hoisted(() => ({ list: [] as PublicChannel[] }))
vi.mock('../../lib/channels/publicChannels', () => ({
  getPublicChannels: () => mockChannels.list,
  getPublicChannel: (id: string) => mockChannels.list.find((c) => c.id === id),
}))

beforeEach(() => {
  mockChannels.list = []
})

/** preferences 允许只给关心的字段，其余由 normalizeSettings 补默认值。 */
type ByokOverrides = Partial<Omit<UserByokProfile, 'id' | 'source' | 'preferences'>> & {
  preferences?: Partial<UserByokPreferences>
}

function byokSettings(overrides: ByokOverrides = {}): AppSettings {
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    profiles: [
      {
        id: 'p1',
        source: 'user-byok',
        name: 'P',
        kind: 'openai-compat',
        baseUrl: 'https://x.test/v1',
        apiKey: 'k',
        ...overrides,
      },
    ],
    activeProfileId: 'p1',
  })
}

function byokProfile(overrides: ByokOverrides = {}): ClientProfile {
  return getActiveApiProfile(byokSettings(overrides))
}

describe('parameter compatibility', () => {
  it('limits OpenAI output count to 10', () => {
    const settings = normalizeSettings(DEFAULT_SETTINGS)

    expect(getOutputImageLimitForSettings(settings)).toBe(10)
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 12 }, settings).n).toBe(10)
  })

  it('resets transparent_output when output format is not png', () => {
    const settings = normalizeSettings(DEFAULT_SETTINGS)
    const params = {
      ...DEFAULT_PARAMS,
      output_format: 'jpeg' as const,
      transparent_output: true,
    }

    expect(normalizeParamsForSettings(params, settings).transparent_output).toBe(false)
  })

  it('resets leftover transparent_output on gemini profiles where the toggle is hidden', () => {
    const params = { ...DEFAULT_PARAMS, transparent_output: true }

    expect(
      normalizeParamsForSettings(params, byokSettings({ kind: 'gemini' })).transparent_output,
    ).toBe(false)
  })

  it('keeps explicit no_rewrite choice across gemini profiles (guard is provider-gated at dispatch)', () => {
    const params = { ...DEFAULT_PARAMS, no_rewrite: false }

    expect(normalizeParamsForSettings(params, byokSettings({ kind: 'gemini' })).no_rewrite).toBe(
      false,
    )
  })
})

describe('getParamCapabilities', () => {
  it('png on openai profile: transparent toggle on, compression off', () => {
    expect(getParamCapabilities(byokProfile(), 'png')).toEqual({
      quality: true,
      transparentOutput: true,
      compression: false,
      moderation: true,
    })
  })

  it('jpeg: transparent toggle off, compression on', () => {
    const caps = getParamCapabilities(byokProfile(), 'jpeg')
    expect(caps.transparentOutput).toBe(false)
    expect(caps.compression).toBe(true)
  })

  it('gemini profile: transparent toggle always off', () => {
    expect(getParamCapabilities(byokProfile({ kind: 'gemini' }), 'png').transparentOutput).toBe(
      false,
    )
  })

  it('codexCli profile: quality off', () => {
    const profile = byokProfile({ preferences: { codexCli: true } })
    expect(getParamCapabilities(profile, 'png').quality).toBe(false)
  })

  it('responses apiMode: moderation off', () => {
    const profile = byokProfile({ preferences: { apiMode: 'responses' } })
    expect(getParamCapabilities(profile, 'png').moderation).toBe(false)
  })

  it('builtin-edge channel without quality capability: quality off', () => {
    mockChannels.list = [
      {
        id: 'c1',
        kind: 'openai-queue',
        label: 'C',
        models: [{ id: 'm1', label: 'M', capabilities: ['generate', 'edit'] }],
        defaults: { apiMode: 'images', timeout: 600 },
      },
    ]
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [{ id: 'bp', source: 'builtin-edge', channelId: 'c1', selectedModelId: 'm1' }],
      activeProfileId: 'bp',
    })
    expect(getParamCapabilities(getActiveApiProfile(settings), 'png').quality).toBe(false)
  })
})

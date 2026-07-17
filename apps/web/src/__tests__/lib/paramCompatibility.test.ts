import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, normalizeSettings } from '../../lib/apiProfiles'
import {
  getOutputImageLimitForSettings,
  normalizeParamsForSettings,
} from '../../lib/paramCompatibility'
import { DEFAULT_PARAMS } from '../../types'

function settingsWithGeminiByok() {
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    profiles: [
      {
        id: 'gemini-profile',
        source: 'user-byok',
        name: 'Gemini',
        kind: 'gemini',
        baseUrl: '',
        apiKey: 'k',
      },
    ],
    activeProfileId: 'gemini-profile',
  })
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

    expect(normalizeParamsForSettings(params, settingsWithGeminiByok()).transparent_output).toBe(
      false,
    )
  })

  it('keeps explicit no_rewrite choice across gemini profiles (guard is provider-gated at dispatch)', () => {
    const params = { ...DEFAULT_PARAMS, no_rewrite: false }

    expect(normalizeParamsForSettings(params, settingsWithGeminiByok()).no_rewrite).toBe(false)
  })
})

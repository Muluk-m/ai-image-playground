import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, normalizeSettings } from '../../lib/apiProfiles'
import {
  getOutputImageLimitForSettings,
  normalizeParamsForSettings,
} from '../../lib/paramCompatibility'
import { DEFAULT_PARAMS } from '../../types'

describe('parameter compatibility', () => {
  it('limits OpenAI output count to 10', () => {
    const settings = normalizeSettings(DEFAULT_SETTINGS)

    expect(getOutputImageLimitForSettings(settings)).toBe(10)
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 12 }, settings).n).toBe(10)
  })
})

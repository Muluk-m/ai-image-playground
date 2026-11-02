import { describe, expect, it } from 'vitest'
import { readAutoSubmitPreference } from '../../../../features/agent/lib/autoSubmitPreference'

describe('readAutoSubmitPreference', () => {
  it('defaults direct generation on until the user turns it off', () => {
    expect(readAutoSubmitPreference(null)).toBe(true)
    expect(readAutoSubmitPreference('1')).toBe(true)
    expect(readAutoSubmitPreference('0')).toBe(false)
  })
})

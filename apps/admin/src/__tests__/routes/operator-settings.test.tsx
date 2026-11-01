// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { formatSettingValue, parseSettingInput } from '../../routes/_authed.operator-settings'

describe('operator settings units', () => {
  it('round-trips byte values as MB/GB', () => {
    expect(formatSettingValue(10 * 1024 * 1024, 'bytes')).toBe('10 MB')
    expect(parseSettingInput('10 MB', 'bytes')).toBe(10 * 1024 * 1024)
    expect(formatSettingValue(2 * 1024 ** 3, 'bytes')).toBe('2 GB')
    expect(parseSettingInput('2 GB', 'bytes')).toBe(2 * 1024 ** 3)
  })

  it('round-trips minute values in seconds', () => {
    expect(formatSettingValue(120, 'seconds')).toBe('2 分钟')
    expect(parseSettingInput('2 分钟', 'seconds')).toBe(120)
  })
})

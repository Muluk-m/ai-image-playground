import { expect, it } from 'vitest'
import { adminTime, isoTime } from '../../lib/format'

it('formats admin timestamps in Beijing time with a zone label', () => {
  const at = Date.UTC(2026, 10, 17, 10, 8, 7)
  expect(isoTime(at)).toBe('2026-11-17 10:08:07')
  expect(adminTime(at)).toContain('18:08:07')
  expect(adminTime(at)).toContain('北京时间')
  expect(adminTime(at)).not.toContain('10:08:07')
})

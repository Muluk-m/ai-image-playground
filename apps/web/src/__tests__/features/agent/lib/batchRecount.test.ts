import { describe, expect, it } from 'vitest'
import { recountBatchText } from '../../../../features/agent/lib/batchRecount'

describe('recountBatchText', () => {
  it('删减后把写死的总数改成实际项数', () => {
    expect(recountBatchText('共 3 张独立水果静物图', 3, 2)).toBe('共 2 张独立水果静物图')
    expect(recountBatchText('共3项，统一白底', 3, 1)).toBe('共1项，统一白底')
  })

  it('其他数字和项数未变时原样保留', () => {
    expect(recountBatchText('共 3 张，比例 16:9、9:16', 3, 3)).toBe('共 3 张，比例 16:9、9:16')
    expect(recountBatchText('共 13 张，每张 3 种配色', 3, 2)).toBe('共 13 张，每张 3 种配色')
  })
})

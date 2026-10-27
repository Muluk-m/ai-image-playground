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

  it('中文数字写的总数也跟着改', () => {
    expect(recountBatchText('三张水果静物保持统一的写实质感；每张只突出指定水果', 3, 2)).toBe(
      '两张水果静物保持统一的写实质感；每张只突出指定水果',
    )
    expect(recountBatchText('共十二幅海报', 12, 11)).toBe('共十一幅海报')
    expect(recountBatchText('两张一组，共十张', 10, 9)).toBe('两张一组，共九张')
    expect(recountBatchText('从十三张备选里选', 3, 2)).toBe('从十三张备选里选')
  })
})

import { describe, expect, it } from 'vitest'
import { pruneRemovedFromList, recountBatchText } from '../../../../features/agent/lib/batchRecount'

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

  it('序数和局部数量不当作总数', () => {
    expect(recountBatchText('共三张水果图；第三张用俯视构图', 3, 2)).toBe(
      '共两张水果图；第三张用俯视构图',
    )
    expect(recountBatchText('共三张，每组三张', 3, 2)).toBe('共两张，每组三张')
    expect(recountBatchText('共 三张，每组 三张', 3, 2)).toBe('共 两张，每组 三张')
    expect(recountBatchText('风格统一。 三张都用暖色', 3, 2)).toBe('风格统一。 两张都用暖色')
  })
})

describe('pruneRemovedFromList', () => {
  const banana = '一根成熟的黄色香蕉放在木桌上，静物摄影'
  const grape = '一串紫色葡萄放在白瓷盘里，静物摄影'
  const orange = '一个切开的橙子，竖版构图，静物摄影'

  it('drops the removed fruit from the rule and recounts the trailing count', () => {
    expect(
      pruneRemovedFromList(
        '分别创作香蕉、葡萄、橙子三张独立水果静物图；每张只聚焦对应水果',
        orange,
        [banana, grape],
      ),
    ).toBe('分别创作香蕉、葡萄两张独立水果静物图；每张只聚焦对应水果')
  })

  it('handles the first and middle entries', () => {
    expect(pruneRemovedFromList('分别创作香蕉、葡萄、橙子三张', banana, [grape, orange])).toBe(
      '分别创作葡萄、橙子两张',
    )
    expect(pruneRemovedFromList('香蕉、葡萄、橙子各 3 张', grape, [banana, orange])).toBe(
      '香蕉、橙子各 3 张',
    )
    expect(pruneRemovedFromList('香蕉、葡萄、橙子3张', grape, [banana, orange])).toBe(
      '香蕉、橙子2张',
    )
  })

  it('leaves names that kept items still use, or that the removed item never mentioned', () => {
    expect(pruneRemovedFromList('写实、静物、自然光', orange, [banana, grape])).toBe(
      '写实、静物、自然光',
    )
    expect(pruneRemovedFromList('香蕉、葡萄、苹果三张', orange, [banana, grape])).toBe(
      '香蕉、葡萄、苹果三张',
    )
  })
})
